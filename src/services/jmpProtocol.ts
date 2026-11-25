/**
 * Pure (VS Code-free) logic for talking to the `jmp` CLI: argument
 * construction, output parsing, error classification, capability gating and
 * config-home resolution. Everything here is unit-testable under plain Node.
 */

import * as path from "path";

import { Exporter, ExporterStatus } from "../types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable classification of a failed jmp invocation. */
export type JmpErrorKind =
  /** No active Python interpreter could be resolved. */
  | "no-python"
  /** The interpreter has no jumpstarter_cli module (or jmpPath doesn't exist). */
  | "no-jmp-in-env"
  /** Token expired / missing / invalid — caller must stop background polling and surface re-auth. */
  | "auth-expired"
  /** Controller unreachable (gRPC UNAVAILABLE, DNS, refused, timeout...). */
  | "connection-failed"
  /** CLI usage error (exit code 2). */
  | "usage"
  /** stdout was not valid JSON of the expected shape. */
  | "parse-error"
  /** Anything else (exit 1 with an unrecognized error message, signals...). */
  | "unknown";

export class JmpError extends Error {
  readonly kind: JmpErrorKind;
  readonly exitCode: number | undefined;
  readonly stderr: string;
  readonly stdout: string;
  /**
   * The argv (after the interpreter/module prefix) that failed, with values
   * of secret-bearing flags redacted (see redactSecretArgs).
   */
  readonly args: readonly string[];

  constructor(
    kind: JmpErrorKind,
    message: string,
    opts: {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      args?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = "JmpError";
    this.kind = kind;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr ?? "";
    this.stdout = opts.stdout ?? "";
    this.args = opts.args ?? [];
  }
}

const AUTH_PATTERNS = [
  /token\s+(is\s+)?expired/i,
  /expired\s+token/i,
  /invalid\s+token/i,
  /no\s+token/i,
  /unauthenticated/i,
  /unauthorized/i,
  /permission\s+denied/i,
  /authentication\s+(failed|required)/i,
  /\b401\b/,
];

const CONNECTION_PATTERNS = [
  /unavailable/i,
  /failed to connect/i,
  /connection\s+(refused|reset|error|failed)/i,
  /could not connect/i,
  /name resolution/i,
  /dns\b/i,
  /getaddrinfo/i,
  /socket\s+closed/i,
  /deadline exceeded/i,
  /timed?\s*out/i,
  /network is unreachable/i,
];

const NO_JMP_PATTERNS = [
  /no module named\s+['"]?jumpstarter_cli/i,
  /no module named\s+['"]?jumpstarter/i,
];

/**
 * Classify a finished (non-zero or unparseable) jmp invocation.
 * `stderrText` is the accumulated stderr; `exitCode` is null when the process
 * was killed by a signal or failed to spawn (pass spawnError in that case).
 */
export function classifyError(
  exitCode: number | null,
  stderrText: string,
  opts: { spawnErrorCode?: string } = {},
): JmpErrorKind {
  if (opts.spawnErrorCode === "ENOENT" || opts.spawnErrorCode === "EACCES") {
    return "no-jmp-in-env";
  }
  if (NO_JMP_PATTERNS.some((re) => re.test(stderrText))) {
    return "no-jmp-in-env";
  }
  if (exitCode === 2) {
    return "usage";
  }
  if (AUTH_PATTERNS.some((re) => re.test(stderrText))) {
    return "auth-expired";
  }
  if (CONNECTION_PATTERNS.some((re) => re.test(stderrText))) {
    return "connection-failed";
  }
  return "unknown";
}

/**
 * What went wrong, for human display.
 *
 * A gRPC failure is printed over several lines, and its first one ends where
 * the reason begins ("Error: grpc error (Caused by: <AioRpcError ...:"): the
 * reason is the `details = "..."` line, so that is what is shown. Otherwise
 * the first line of stderr that looks like an error.
 */
export function summarizeStderr(stderrText: string): string {
  const lines = stderrText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const details = /^\s*details\s*=\s*"(.*)"\s*$/m.exec(stderrText);
  if (details && details[1].trim().length > 0) {
    const status = /^\s*status\s*=\s*StatusCode\.(\w+)\s*$/m.exec(stderrText);
    return status ? `${details[1]} (${status[1]})` : details[1];
  }
  const errLine = lines.find((l) => /error/i.test(l));
  return (errLine ?? lines[lines.length - 1] ?? "jmp failed").trim();
}

/**
 * Split stderr into warning lines. All stderr output from a *successful*
 * invocation is treated as warnings to surface (never parse).
 */
export function extractWarnings(stderrText: string): string[] {
  return stderrText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/** Parse stdout as JSON; throws JmpError("parse-error") on failure. */
export function parseJsonOutput<T>(stdout: string, args: readonly string[]): T {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new JmpError(
      "parse-error",
      `jmp produced unparseable JSON output for: jmp ${args.join(" ")}`,
      { stdout, args },
    );
  }
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

/**
 * Tag automatically applied to every lease created by the extension.
 *
 * The key has no prefix: the controller keeps `jumpstarter.dev/` for itself
 * and refuses a lease that is tagged with it.
 */
export const CREATED_BY_TAG_KEY = "created-by";
/** The key earlier versions used; leases that carry it are still recognised. */
export const LEGACY_CREATED_BY_TAG_KEY = "jumpstarter.dev/created-by";
export const CREATED_BY_TAG_VALUE = "vscode";

export interface CreateLeaseOptions {
  /** Lease a specific exporter by name (`-n`). Mutually exclusive with selector. */
  exporterName?: string;
  /** Label selector, e.g. "board=rpi4,site=lab1" (`-l`). */
  selector?: string;
  /** Duration string as accepted by the CLI, e.g. "30m", "1h". */
  duration: string;
  /** Additional tags; the created-by=vscode tag is always added. */
  tags?: Record<string, string>;
}

export function buildVersionArgs(): string[] {
  return ["version", "-o", "json"];
}

/**
 * `jmp get exporters --with leases,online,status [--show-hidden-labels] -o json --client <client>`
 *
 * A controller can be configured to hide labels from listings, and the labels
 * that say which ExporterSet an exporter belongs to are the usual ones hidden:
 * without them a pool's members look like exporters that stand alone. They are
 * asked for unless this `jmp` has no such option (see isNoSuchOption).
 */
export function buildGetExportersArgs(client: string, showHiddenLabels = true): string[] {
  return [
    "get",
    "exporters",
    "--with",
    "leases,online,status",
    ...(showHiddenLabels ? [SHOW_HIDDEN_LABELS_OPTION] : []),
    "-o",
    "json",
    "--client",
    client,
  ];
}

export const SHOW_HIDDEN_LABELS_OPTION = "--show-hidden-labels";

/** Whether a failed command was refused because this `jmp` has no such option. */
export function isNoSuchOption(error: unknown, option: string): boolean {
  return (
    error instanceof JmpError &&
    error.kind === "usage" &&
    error.stderr.toLowerCase().includes(`no such option: ${option}`)
  );
}

/**
 * ExporterStatus names indexed by their protobuf ordinal.
 *
 * CLIs older than the status-name serializer emit the raw enum integer in
 * JSON rather than the name; map it back so both wire forms categorize alike.
 */
const EXPORTER_STATUS_BY_ORDINAL: readonly ExporterStatus[] = [
  "UNSPECIFIED",
  "OFFLINE",
  "AVAILABLE",
  "BEFORE_LEASE_HOOK",
  "LEASE_READY",
  "AFTER_LEASE_HOOK",
  "BEFORE_LEASE_HOOK_FAILED",
  "AFTER_LEASE_HOOK_FAILED",
];

/** Normalize a raw JSON `status` (name, ordinal, null or absent) to a name. */
export function normalizeExporterStatus(raw: unknown): ExporterStatus | null {
  if (typeof raw === "number") {
    return EXPORTER_STATUS_BY_ORDINAL[raw] ?? null;
  }
  if (typeof raw === "string") {
    return EXPORTER_STATUS_BY_ORDINAL.includes(raw as ExporterStatus)
      ? (raw as ExporterStatus)
      : null;
  }
  return null;
}

/** Apply wire-format normalization to one exporter from `jmp get exporters`. */
export function normalizeExporter(exporter: Exporter): Exporter {
  return { ...exporter, status: normalizeExporterStatus(exporter.status) };
}

/** Shell-safe (POSIX) rendering of one argument. */
function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render an argv as a command line to type into a terminal.
 *
 * Used where the command must run inside a shell that outlives it, so its
 * output stays on screen after it exits.
 */
export function shellQuote(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

export function buildGetLeasesArgs(client: string, includeEnded = false): string[] {
  const args = ["get", "leases", "-o", "json", "--client", client];
  if (includeEnded) {
    args.push("-a");
  }
  return args;
}

export function buildCreateLeaseArgs(client: string, opts: CreateLeaseOptions): string[] {
  if (!opts.exporterName && !opts.selector) {
    throw new JmpError("usage", "createLease requires exporterName or selector");
  }
  if (opts.exporterName && opts.selector) {
    throw new JmpError("usage", "createLease takes exporterName or selector, not both");
  }
  const args = ["create", "lease", "--client", client];
  if (opts.exporterName) {
    args.push("-n", opts.exporterName);
  } else if (opts.selector) {
    args.push("-l", opts.selector);
  }
  args.push("--duration", opts.duration);
  const tags: Record<string, string> = {
    ...opts.tags,
    [CREATED_BY_TAG_KEY]: CREATED_BY_TAG_VALUE,
  };
  for (const [k, v] of Object.entries(tags)) {
    args.push("--tag", `${k}=${v}`);
  }
  args.push("-o", "name");
  return args;
}

export function buildDeleteLeaseArgs(client: string, name: string): string[] {
  return ["delete", "leases", name, "--client", client];
}

export function buildUpdateLeaseArgs(client: string, name: string, duration: string): string[] {
  return ["update", "lease", name, "--duration", duration, "--client", client];
}

export function buildListClientsArgs(): string[] {
  return ["config", "client", "list", "-o", "json"];
}

export function buildDriverSchemaArgs(): string[] {
  return ["driver", "schema", "-o", "json"];
}

/** Options for connecting straight to an exporter, with no controller. */
export interface DirectConnectOptions {
  /** host:port the exporter serves on. */
  address: string;
  /** Connect without TLS. */
  insecure?: boolean;
  /** Shared passphrase, when the exporter requires one. */
  passphrase?: string;
}

/**
 * `jmp shell --tls-grpc host:port ...` — a session against a standalone
 * exporter. No controller is involved, so there is no lease to acquire or
 * release.
 */
export function buildDirectShellArgs(
  options: DirectConnectOptions,
  command?: readonly string[],
): string[] {
  const args = ["shell", "--tls-grpc", options.address];
  if (options.insecure) {
    args.push("--tls-grpc-insecure");
  }
  if (options.passphrase) {
    args.push("--passphrase", options.passphrase);
  }
  if (command && command.length > 0) {
    args.push("--", ...command);
  }
  return args;
}

/**
 * `jmp shell --exporter <alias>` — serve a locally configured exporter and
 * open a session against it, without registering with a controller.
 */
export function buildLocalExporterShellArgs(alias: string, command?: readonly string[]): string[] {
  const args = ["shell", "--exporter", alias];
  if (command && command.length > 0) {
    args.push("--", ...command);
  }
  return args;
}

/** True for a plausible host:port, which is all --tls-grpc accepts. */
export function isValidAddress(value: string): boolean {
  const trimmed = value.trim();
  const match = /^\[?([^\]]+)\]?:(\d{1,5})$/.exec(trimmed);
  if (!match) {
    return false;
  }
  const port = Number(match[2]);
  return match[1].length > 0 && port > 0 && port <= 65535;
}

export function buildListExporterConfigsArgs(): string[] {
  return ["config", "exporter", "list", "-o", "json"];
}

export function buildUseClientArgs(alias: string): string[] {
  return ["config", "client", "use", alias];
}

export function buildDeleteClientArgs(alias: string): string[] {
  return ["config", "client", "delete", alias];
}

export function buildAuthStatusArgs(client: string): string[] {
  return ["auth", "status", "--client", client, "-o", "json"];
}

export function buildDriverListArgs(): string[] {
  return ["driver", "list", "-o", "json"];
}

export function buildDescribeArgs(
  kind: "exporter" | "lease" | "client",
  name: string,
  client?: string,
): string[] {
  const args = ["describe", kind, name, "-o", "json"];
  if (client) {
    args.push("--client", client);
  }
  return args;
}

export function buildDescribeLeaseWithDriversArgs(client: string, name: string): string[] {
  return ["describe", "lease", name, "--drivers", "-o", "json", "--client", client];
}

/**
 * Args (after the invocation prefix) for `jmp shell`. When `command` is given
 * it is run inside the lease session (`-- <command...>`); otherwise an
 * interactive shell is opened. Always passes --lease (required on non-TTY
 * stdin with multiple leases; unambiguous everywhere).
 */
export function buildShellArgs(client: string, lease: string, command?: readonly string[]): string[] {
  const args = ["shell", "--client", client, "--lease", lease];
  if (command && command.length > 0) {
    args.push("--", ...command);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Cluster administration (`jmp admin ...`)
//
// These talk to the Kubernetes API with the user's kubeconfig rather than to
// the controller with a client token, so they see every resource in a
// namespace instead of the ones one client may reach.
// ---------------------------------------------------------------------------

/** How to reach the cluster; every field falls back to the CLI's own default. */
export interface AdminOptions {
  /** Kubernetes namespace. Defaults to the CLI's "default". */
  namespace?: string;
  /** Path to a kubeconfig file. Defaults to the usual KUBECONFIG resolution. */
  kubeconfig?: string;
  /** Kubeconfig context. Defaults to the current context. */
  context?: string;
}

/** Resource kinds `jmp admin get` can list. */
export type AdminKind = "client" | "exporter" | "lease" | "exporterset";

export function buildAdminOptionArgs(options: AdminOptions = {}): string[] {
  const args: string[] = [];
  if (options.namespace) {
    args.push("-n", options.namespace);
  }
  if (options.kubeconfig) {
    args.push("--kubeconfig", options.kubeconfig);
  }
  if (options.context) {
    args.push("--context", options.context);
  }
  return args;
}

/** `jmp admin get <kind> [name] -o json` */
export function buildAdminGetArgs(
  kind: AdminKind,
  options: AdminOptions = {},
  name?: string,
): string[] {
  const args = ["admin", "get", kind];
  if (name) {
    args.push(name);
  }
  return [...args, ...buildAdminOptionArgs(options), "-o", "json"];
}

/** Allowed driver clients for an imported client config. */
export interface ImportDriverAccess {
  /** Driver client packages the config may import. */
  allow?: readonly string[];
  /** Allow every driver client package (unsafe). */
  unsafe?: boolean;
}

/**
 * `jmp admin import <kind> <name> ... -o path`
 *
 * Fetches the credentials the cluster generated for an existing client or
 * exporter and writes them to a local config, printing only the path it wrote.
 * Always non-interactive: the CLI would otherwise prompt on a pipe and hang.
 */
export function buildAdminImportArgs(
  kind: "client" | "exporter",
  name: string,
  options: AdminOptions = {},
  access: ImportDriverAccess & { out?: string } = {},
): string[] {
  const args = ["admin", "import", kind, name, ...buildAdminOptionArgs(options)];
  if (kind === "client") {
    if (access.unsafe) {
      args.push("--unsafe");
    } else if (access.allow && access.allow.length > 0) {
      args.push("-a", access.allow.join(","));
    }
  }
  if (access.out) {
    args.push("--out", access.out);
  }
  args.push("--nointeractive", "-o", "path");
  return args;
}

/** `jmp admin apply -f <file> ... -o json` */
export function buildAdminApplyArgs(
  files: readonly string[],
  options: AdminOptions = {},
  opts: { dryRun?: boolean } = {},
): string[] {
  if (files.length === 0) {
    throw new JmpError("usage", "apply requires at least one manifest file");
  }
  const args = ["admin", "apply"];
  for (const file of files) {
    args.push("-f", file);
  }
  args.push(...buildAdminOptionArgs(options));
  if (opts.dryRun) {
    args.push("--dry-run");
  }
  return [...args, "-o", "json"];
}

// ---------------------------------------------------------------------------
// Version gate / capabilities
// ---------------------------------------------------------------------------

/** Feature flags derived from the probed jmp version and user settings. */
export interface JmpCapabilities {
  /** `jmp auth status -o json` exists. */
  authStatus: boolean;
  /** `jmp driver list -o json` exists. */
  driverList: boolean;
  /** `jmp driver schema -o json` exists (per-driver config keys). */
  driverSchema: boolean;
  /** Lease driver introspection exists (including the legacy integration-branch API). */
  describeDrivers: boolean;
  /** `--with leases,online,status` on `jmp get exporters` exists. */
  exporterStatusColumns: boolean;
  /** `jmp get leases` reports the status field. */
  leaseStatus: boolean;
  /** `jmp admin get exporterset` exists. */
  adminExporterSets: boolean;
  /** `jmp admin apply -f` exists. */
  adminApply: boolean;
}

/**
 * Parse a jmp gitVersion like "0.10.0.dev34+gd787eecab.d20260829" or "0.7.1"
 * into [major, minor, patch]; null when unparseable.
 */
export function parseGitVersion(gitVersion: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(gitVersion.trim());
  if (!m) {
    return null;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
}

/** Version family used by current main; not a subcommand probe for older dev builds. */
export const MAIN_FEATURE_VERSION: [number, number, number] = [0, 10, 0];

/**
 * Compute capability flags from a probed version.
 *
 * The capabilities already in Jumpstarter's current `main` are enabled by
 * the version gate. APIs that are still only on the IDE integration branch
 * require the explicit opt-in, so a checkout of current `main` never gets
 * sent arguments it does not understand.
 */
export function computeCapabilities(
  gitVersion: string,
  experimentalCliFeatures = false,
  experimentalDriverSchemas = false,
): JmpCapabilities {
  const v = parseGitVersion(gitVersion);
  const atLeast = (min: [number, number, number]): boolean => {
    if (v === null) {
      // Unparseable — assume a current dev build; experimental APIs still need opt-in.
      return true;
    }
    for (let i = 0; i < 3; i++) {
      if (v[i] > min[i]) {
        return true;
      }
      if (v[i] < min[i]) {
        return false;
      }
    }
    return true;
  };
  const main = atLeast(MAIN_FEATURE_VERSION);
  const experimental = main && experimentalCliFeatures;
  return {
    authStatus: main,
    driverList: main,
    driverSchema: experimental && experimentalDriverSchemas,
    describeDrivers: experimental,
    exporterStatusColumns: main,
    leaseStatus: main,
    adminExporterSets: experimental,
    adminApply: experimental,
  };
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_FLAGS = new Set(["-t", "--token", "--password", "--passphrase"]);

/**
 * Replace the value following any secret-bearing flag with "***" (handles
 * both "-t X" and "--token=X" styles). JmpService.run applies this to every
 * argv before it is logged or embedded in a JmpError, so commands like
 * `config client create -t TOKEN` can never leak credentials.
 */
export function redactSecretArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      out.push("***");
      redactNext = false;
      continue;
    }
    if (SECRET_FLAGS.has(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0 && SECRET_FLAGS.has(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=***`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config home
// ---------------------------------------------------------------------------

/**
 * Directory holding config.yaml and clients/<alias>.yaml, matching the CLI's
 * resolution (jumpstarter/config/common.py): $JMP_CLIENT_CONFIG_HOME, else
 * $XDG_CONFIG_HOME/jumpstarter when XDG_CONFIG_HOME is set and non-empty,
 * else ~/.config/jumpstarter.
 */
export function resolveConfigHome(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  const override = env["JMP_CLIENT_CONFIG_HOME"];
  if (override && override.trim().length > 0) {
    return override;
  }
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg && xdg.trim().length > 0) {
    return path.join(xdg, "jumpstarter");
  }
  return path.join(homedir, ".config", "jumpstarter");
}

/**
 * The `jmp` executable a PATH leads to, or undefined. For an environment that
 * has no Python extension to ask (a container that simply has `jmp`
 * installed): the first directory of PATH that has the executable wins, as in
 * a shell.
 */
export function findOnPath(
  name: string,
  pathValue: string | undefined,
  isExecutable: (file: string) => boolean,
  delimiter = ":",
  separator = "/",
): string | undefined {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = directory.endsWith(separator) ? `${directory}${name}` : `${directory}${separator}${name}`;
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
