/**
 * Pure (VS Code-free) logic for talking to the `jmp` CLI: argument
 * construction, output parsing, error classification, capability gating and
 * config-home resolution. Everything here is unit-testable under plain Node.
 */

import * as path from "path";

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
  /** The full argv (after the interpreter/module prefix) that failed. */
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

/** First line of stderr that looks like an error, for human display. */
export function summarizeStderr(stderrText: string): string {
  const lines = stderrText.split(/\r?\n/).filter((l) => l.trim().length > 0);
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

/** Tag automatically applied to every lease created by the extension. */
export const CREATED_BY_TAG_KEY = "jumpstarter.dev/created-by";
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

export function buildGetExportersArgs(client: string): string[] {
  return [
    "get",
    "exporters",
    "--with",
    "leases,online,status",
    "-o",
    "json",
    "--client",
    client,
  ];
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

export function buildDescribeLeaseWithDevicesArgs(client: string, name: string): string[] {
  return ["describe", "lease", name, "--devices", "-o", "json", "--client", client];
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
// Version gate / capabilities
// ---------------------------------------------------------------------------

/** Feature flags derived from the probed jmp version. */
export interface JmpCapabilities {
  /** `jmp auth status -o json` exists. */
  authStatus: boolean;
  /** `jmp driver list -o json` exists. */
  driverList: boolean;
  /** `jmp describe lease --devices -o json` exists. */
  describeDevices: boolean;
  /** `--with leases,online,status` on `jmp get exporters` exists. */
  exporterStatusColumns: boolean;
  /** `jmp get leases` reports the status field. */
  leaseStatus: boolean;
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

/** Minimum jmp version carrying every capability the extension uses. */
export const FULL_FEATURE_VERSION: [number, number, number] = [0, 10, 0];

/**
 * Compute capability flags from a probed version. Versions at or above
 * FULL_FEATURE_VERSION (and unparseable dev versions) get everything;
 * older releases are assumed to lack the newer JSON subcommands.
 */
export function computeCapabilities(gitVersion: string): JmpCapabilities {
  const v = parseGitVersion(gitVersion);
  const atLeast = (min: [number, number, number]): boolean => {
    if (v === null) {
      // Unparseable — assume a dev build with everything.
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
  const full = atLeast(FULL_FEATURE_VERSION);
  return {
    authStatus: full,
    driverList: full,
    describeDevices: full,
    exporterStatusColumns: full,
    leaseStatus: full,
  };
}

// ---------------------------------------------------------------------------
// Config home
// ---------------------------------------------------------------------------

/**
 * Directory holding config.yaml and clients/<alias>.yaml:
 * $JMP_CLIENT_CONFIG_HOME, else ~/.config/jumpstarter.
 */
export function resolveConfigHome(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  const override = env["JMP_CLIENT_CONFIG_HOME"];
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(homedir, ".config", "jumpstarter");
}
