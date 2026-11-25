/**
 * JmpService — the single bridge between the extension and the `jmp` CLI.
 *
 * Resolves the active Python interpreter via the ms-python extension API and
 * spawns `<python> -m jumpstarter_cli <args...>` (or `<jumpstarter.jmpPath>
 * <args...>` when that setting is set) with NO_COLOR=1 and COLUMNS=4096 and
 * no TTY, so rich emits plain parseable JSON on stdout. stderr is surfaced as
 * warnings in the "Jumpstarter" output channel — never parsed for data.
 *
 * All failures are thrown as JmpError with a machine-readable `kind`
 * (see jmpProtocol.ts): "no-python" | "no-jmp-in-env" | "auth-expired" |
 * "connection-failed" | "usage" | "parse-error" | "unknown".
 */

import * as vscode from "vscode";
import * as path from "path";
import { promises as fs } from "fs";
import * as fsSync from "fs";
import { spawn } from "child_process";
import { PythonExtension } from "@vscode/python-extension";
import * as protocol from "./jmpProtocol";
import { JmpError, JmpCapabilities, CreateLeaseOptions, AdminOptions } from "./jmpProtocol";
import * as leaseProtocol from "./leaseProtocol";
import type { CreateTemplateLeaseOptions, RoleDrivers } from "./leaseProtocol";
import {
  AdminClient,
  AdminExporter,
  AdminExporterSet,
  AdminLease,
  AdminList,
  AppliedResource,
  AuthStatus,
  ClientConfigList,
  ExporterConfigRef,
  DriverInfo,
  DriverListResponse,
  DriverSchema,
  DriverSchemaResponse,
  Exporter,
  ExporterPort,
  GetExportersResponse,
  JmpVersion,
  Lease,
  LeaseTemplate,
  LeaseWithDrivers,
} from "../types";

export {
  JmpError,
  JmpErrorKind,
  JmpCapabilities,
  CreateLeaseOptions,
  AdminOptions,
} from "./jmpProtocol";

/** How jmp will be invoked: an executable plus fixed prefix args. */
export interface JmpInvocation {
  /** Executable: the jmpPath override, or the active python interpreter. */
  command: string;
  /** Prefix args: [] for a jmp binary, ["-m", "jumpstarter_cli"] for python. */
  prefixArgs: string[];
}

/** Result of the version-gate probe. */
export type JmpAvailability =
  | { kind: "ok"; version: JmpVersion; capabilities: JmpCapabilities }
  | { kind: "no-python" }
  | { kind: "no-jmp-in-env"; python: string }
  | { kind: "error"; error: JmpError };

/**
 * The lease templates a client can request, or why there are none to ask
 * for: a `jmp` or a controller from before lease templates is not an error.
 */
export type LeaseTemplatesResult =
  | { kind: "ok"; templates: LeaseTemplate[] }
  | { kind: "unavailable"; reason: string };

export interface RunResult {
  stdout: string;
  /** Raw stderr text. */
  stderr: string;
  /** Non-empty stderr lines (already logged to the output channel). */
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** How long the answer to a local read serves the other views of the same refresh. */
const SHARED_READ_MS = 5_000;
/** How long the ports the exporters declare are kept: they are part of an exporter's configuration. */
const PORTS_MS = 60_000;

export class JmpService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sharedReads = new Map<string, { value: Promise<unknown>; until: number }>();

  private readonly interpreterEmitter = new vscode.EventEmitter<void>();
  /** Fires when the active Python environment or jmpPath setting changes. */
  readonly onDidChangeInterpreter: vscode.Event<void> = this.interpreterEmitter.event;

  private readonly availabilityEmitter = new vscode.EventEmitter<JmpAvailability>();
  /** Fires after every (re-)probe of jmp availability. */
  readonly onDidChangeAvailability: vscode.Event<JmpAvailability> = this.availabilityEmitter.event;

  /** Shared output channel for warnings and command logs. */
  readonly output: vscode.OutputChannel;

  private pythonApi: PythonExtension | undefined;
  private availability: JmpAvailability | undefined;
  /** The ports of a client's exporters, as last read; see getExporterPorts. */
  private readonly ports = new Map<string, { value: Record<string, ExporterPort[]>; until: number }>();
  /** Set once this `jmp` refused `--with ports`: it is not asked again until the next probe. */
  private portsUnsupported = false;
  /** Set once this `jmp` refused `--show-hidden-labels`: it is not passed again until the next probe. */
  private hiddenLabelsUnsupported = false;
  /** Set once this `jmp` had no `driver schema` command: it is not asked again until the next probe. */
  private driverSchemaUnsupported = false;

  constructor(output?: vscode.OutputChannel) {
    this.output = output ?? vscode.window.createOutputChannel("Jumpstarter");
    if (!output) {
      this.disposables.push(this.output);
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("jumpstarter.jmpPath")) {
          this.interpreterEmitter.fire();
        }
        if (
          e.affectsConfiguration("jumpstarter.jmpPath") ||
          e.affectsConfiguration("jumpstarter.experimentalCliFeatures")
        ) {
          void this.probe();
        }
      }),
    );
  }

  /**
   * Hook up the Python extension API and run the initial availability probe.
   * Safe to call once from activate(); never throws.
   */
  async initialize(): Promise<void> {
    try {
      this.pythonApi = await PythonExtension.api();
      this.disposables.push(
        this.pythonApi.environments.onDidChangeActiveEnvironmentPath(() => {
          this.interpreterEmitter.fire();
          void this.pythonPathOrEmpty().then((p) =>
            this.log(`Active interpreter changed: ${p || "(none)"}`),
          );
          void this.probe();
        }),
      );
    } catch (err) {
      this.log(`Python extension unavailable: ${String(err)}`);
    }
    await this.probe();
  }

  // -------------------------------------------------------------------------
  // Availability / version gate
  // -------------------------------------------------------------------------

  /** Last probe result; undefined before initialize() completes. */
  getAvailability(): JmpAvailability | undefined {
    return this.availability;
  }

  /** Fail closed before probing, and honor opt-out immediately (even during a re-probe). */
  hasCapability(capability: keyof JmpCapabilities): boolean {
    if (this.availability?.kind !== "ok") {
      return false;
    }
    if (capability === "driverSchema" && this.driverSchemaUnsupported) {
      return false;
    }
    return this.configuredCapabilities(this.availability.version.gitVersion)[capability];
  }

  private configuredCapabilities(gitVersion: string): JmpCapabilities {
    const config = vscode.workspace.getConfiguration("jumpstarter");
    return protocol.computeCapabilities(
      gitVersion,
      config.get<boolean>("experimentalCliFeatures", false),
    );
  }

  private requireCapability(capability: keyof JmpCapabilities, command: string): void {
    if (!this.hasCapability(capability)) {
      throw new JmpError(
        "usage",
        capability === "driverSchema"
          ? `${command} requires a Jumpstarter CLI that has it (0.10 or later).`
          : `${command} requires a compatible integration-branch CLI and jumpstarter.experimentalCliFeatures enabled.`,
      );
    }
  }

  /** How many probes have started; see probe(). */
  private probes = 0;

  /** Probe `jmp version -o json` and recompute capability flags. */
  async probe(): Promise<JmpAvailability> {
    // (another interpreter may be another jmp, with other answers)
    this.forgetSharedReads();
    this.ports.clear();
    this.portsUnsupported = false;
    this.hiddenLabelsUnsupported = false;
    this.driverSchemaUnsupported = false;
    // Probes can overlap (activation, a settings change, an interpreter change) and one of a slow CLI can end
    // after one that started later: only the answer of the latest probe says what is available now.
    const mine = ++this.probes;
    let result: JmpAvailability;
    try {
      const invocation = await this.getInvocation();
      const version = await this.runJson<JmpVersion>(protocol.buildVersionArgs(), {
        invocation,
      });
      result = {
        kind: "ok",
        version,
        capabilities: this.configuredCapabilities(version.gitVersion),
      };
    } catch (err) {
      const jmpErr = err instanceof JmpError ? err : new JmpError("unknown", String(err));
      if (jmpErr.kind === "no-python") {
        result = { kind: "no-python" };
      } else if (jmpErr.kind === "no-jmp-in-env") {
        result = { kind: "no-jmp-in-env", python: await this.pythonPathOrEmpty() };
      } else {
        result = { kind: "error", error: jmpErr };
      }
    }
    if (mine !== this.probes) {
      return this.availability ?? result;
    }
    this.availability = result;
    this.log(
      result.kind === "ok"
        ? `jmp available: ${result.version.gitVersion} (${result.version.pythonVersion.split(" ")[0]})`
        : `jmp unavailable: ${result.kind}`,
    );
    this.availabilityEmitter.fire(result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Invocation resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve how to invoke jmp right now. Throws JmpError("no-python") when no
   * jmpPath override is set and no interpreter is available.
   */
  async getInvocation(): Promise<JmpInvocation> {
    const jmpPath = vscode.workspace
      .getConfiguration("jumpstarter")
      .get<string>("jmpPath", "")
      .trim();
    if (jmpPath.length > 0) {
      return { command: jmpPath, prefixArgs: [] };
    }
    const python = await this.pythonPathOrEmpty();
    if (!python) {
      // No interpreter to ask (the Python extension is not there, or has none selected): a `jmp` on the PATH of
      // this machine is the next best thing, and all a container that has Jumpstarter installed needs.
      const onPath = protocol.findOnPath(
        process.platform === "win32" ? "jmp.exe" : "jmp",
        process.env.PATH,
        (file) => {
          try {
            fsSync.accessSync(file, fsSync.constants.X_OK);
            return fsSync.statSync(file).isFile();
          } catch {
            return false;
          }
        },
        path.delimiter,
        path.sep,
      );
      if (onPath) {
        return { command: onPath, prefixArgs: [] };
      }
      throw new JmpError(
        "no-python",
        "No active Python interpreter found (is the Python extension installed?)",
      );
    }
    return { command: python, prefixArgs: ["-m", "jumpstarter_cli"] };
  }

  /**
   * Append a timestamped line to the "Jumpstarter" output channel — the trace
   * of everything the extension asks the CLI to do. Arguments are redacted by
   * the caller; nothing secret reaches this method.
   */
  log(message: string): void {
    const now = new Date();
    const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    this.output.appendLine(`[${stamp}] ${message}`);
  }

  private async pythonPathOrEmpty(): Promise<string> {
    if (!this.pythonApi) {
      return "";
    }
    try {
      const envPath = this.pythonApi.environments.getActiveEnvironmentPath();
      const resolved = await this.pythonApi.environments.resolveEnvironment(envPath);
      return resolved?.executable?.uri?.fsPath ?? envPath?.path ?? "";
    } catch {
      return "";
    }
  }

  // -------------------------------------------------------------------------
  // Process execution
  // -------------------------------------------------------------------------

  /**
   * Run `jmp <args...>` and return raw stdout/stderr. Throws JmpError on
   * non-zero exit, spawn failure or timeout. stderr of successful runs is
   * logged to the output channel as warnings.
   *
   * Secret-safe: any argv value following a secret-bearing flag (-t/--token/
   * --password) is redacted before the argv is logged to the output channel
   * or embedded in a JmpError, so token-carrying commands never leak
   * credentials (see redactSecretArgs in jmpProtocol.ts).
   */
  async run(
    args: string[],
    opts: { timeoutMs?: number; invocation?: JmpInvocation } = {},
  ): Promise<RunResult> {
    const invocation = opts.invocation ?? (await this.getInvocation());
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fullArgs = [...invocation.prefixArgs, ...args];
    const safeArgs = protocol.redactSecretArgs(args);
    const startedAt = Date.now();

    this.log(`$ jmp ${safeArgs.join(" ")}`);

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(invocation.command, fullArgs, {
        env: { ...process.env, NO_COLOR: "1", COLUMNS: "4096" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(
            new JmpError(
              "connection-failed",
              `jmp ${safeArgs.join(" ")} timed out after ${timeoutMs} ms`,
              { args: safeArgs, stdout, stderr },
            ),
          );
        }
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const kind = protocol.classifyError(null, stderr, { spawnErrorCode: err.code });
        reject(
          new JmpError(kind, `Failed to run jmp: ${err.message}`, {
            args: safeArgs,
            stdout,
            stderr,
          }),
        );
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const warnings = protocol.extractWarnings(stderr);
        const elapsed = Date.now() - startedAt;
        if (code === 0) {
          for (const w of warnings) {
            this.log(`[warn] jmp ${args[0] ?? ""}: ${w}`);
          }
          this.log(`  ok (${elapsed} ms, ${stdout.length} bytes)`);
          resolve({ stdout, stderr, warnings });
        } else {
          const kind = protocol.classifyError(code, stderr);
          this.log(
            `[error] jmp ${safeArgs.join(" ")} exited ${code} after ${elapsed} ms` +
              ` (${kind}): ${protocol.summarizeStderr(stderr)}`,
          );
          reject(
            new JmpError(kind, protocol.summarizeStderr(stderr), {
              exitCode: code ?? undefined,
              args: safeArgs,
              stdout,
              stderr,
            }),
          );
        }
      });
    });
  }

  private async runJson<T>(
    args: string[],
    opts: { timeoutMs?: number; invocation?: JmpInvocation } = {},
  ): Promise<T> {
    const { stdout } = await this.run(args, opts);
    return protocol.parseJsonOutput<T>(stdout, args);
  }

  // -------------------------------------------------------------------------
  // Typed CLI methods
  // -------------------------------------------------------------------------

  /** `jmp version -o json` */
  version(): Promise<JmpVersion> {
    return this.runJson<JmpVersion>(protocol.buildVersionArgs());
  }

  /**
   * `jmp get exporters --with leases,online,status --show-hidden-labels -o json --client <client>`
   *
   * The hidden labels are what say which ExporterSet an exporter belongs to.
   * A `jmp` from before the option refuses it: it is then asked without, and
   * a pool's exporters are shown one by one.
   */
  async getExporters(client: string): Promise<Exporter[]> {
    let res: GetExportersResponse;
    try {
      res = await this.runJson<GetExportersResponse>(
        protocol.buildGetExportersArgs(client, !this.hiddenLabelsUnsupported),
      );
    } catch (err) {
      if (this.hiddenLabelsUnsupported || !protocol.isNoSuchOption(err, protocol.SHOW_HIDDEN_LABELS_OPTION)) {
        throw err;
      }
      this.hiddenLabelsUnsupported = true;
      this.log(
        `this jmp has no \`get exporters ${protocol.SHOW_HIDDEN_LABELS_OPTION}\`: ` +
          "the exporters of an exporter set are shown one by one",
      );
      res = await this.runJson<GetExportersResponse>(protocol.buildGetExportersArgs(client, false));
    }
    return (res.exporters ?? []).map(protocol.normalizeExporter);
  }

  /** `jmp get leases -o json --client <client>` (`-a` when includeEnded). */
  async getLeases(client: string, includeEnded = false): Promise<Lease[]> {
    const res = await this.runJson<unknown>(protocol.buildGetLeasesArgs(client, includeEnded));
    // Made safe to render whatever the CLI's version: a lease with members
    // has no exporter, and an older CLI has none of the member fields.
    return leaseProtocol.parseLeases(res);
  }

  /**
   * `jmp get lease-templates -o json --client <client>`: the sets of
   * exporters a lab administrator published for this client to request.
   *
   * A `jmp` that has no such command, and a controller too old for
   * templates, answer `unavailable` with the reason; only other failures
   * (the controller cannot be reached, the token expired) are thrown.
   */
  async getLeaseTemplates(client: string): Promise<LeaseTemplatesResult> {
    try {
      const res = await this.runJson<unknown>(leaseProtocol.buildGetLeaseTemplatesArgs(client));
      return { kind: "ok", templates: leaseProtocol.parseLeaseTemplates(res) };
    } catch (err) {
      const reason = err instanceof JmpError ? leaseProtocol.leaseTemplatesUnavailable(err) : undefined;
      if (reason === undefined) {
        throw err;
      }
      return { kind: "unavailable", reason };
    }
  }

  /**
   * `jmp create lease -t <template> ... -o name`: one lease that holds an
   * exporter for each role of the template. Tags always include
   * created-by=vscode. Resolves to the new lease's name.
   */
  async createTemplateLease(client: string, opts: CreateTemplateLeaseOptions): Promise<string> {
    const { stdout } = await this.run(leaseProtocol.buildCreateTemplateLeaseArgs(client, opts), {
      timeoutMs: 120_000,
    });
    return stdout.trim();
  }

  /**
   * The ports each exporter declares, by exporter name
   * (`jmp get exporters --with ports -o json`): what says which way a
   * forward of a lease goes. Never throws: without an answer (a `jmp` from
   * before ports, a controller that cannot be reached) there are no ports,
   * and a forward is shown without its arrow.
   */
  async getExporterPorts(client: string): Promise<Record<string, ExporterPort[]>> {
    const known = this.ports.get(client);
    if (known && Date.now() < known.until) {
      return known.value;
    }
    if (this.portsUnsupported) {
      return {};
    }
    try {
      const res = await this.runJson<unknown>(leaseProtocol.buildGetExporterPortsArgs(client));
      const value = leaseProtocol.parseExporterPorts(res);
      this.ports.set(client, { value, until: Date.now() + PORTS_MS });
      return value;
    } catch (err) {
      if (err instanceof JmpError && err.kind === "usage") {
        this.portsUnsupported = true;
        this.log("this jmp has no `get exporters --with ports`: forwards are shown without their direction");
      }
      return known?.value ?? {};
    }
  }

  /**
   * The driver tree of every bound role of a lease with members, by role.
   *
   * `jmp describe lease --drivers` connects to the one exporter of a lease
   * and refuses a lease with members, so the trees are read inside the
   * lease's own session (`jmp shell --lease NAME -- python -c ...`), where
   * each role is served; see ROLE_DRIVERS_SCRIPT. Starting the session can
   * be slow, hence the longer timeout.
   */
  async describeRoleDrivers(client: string, lease: string): Promise<Record<string, RoleDrivers>> {
    this.requireCapability("describeDrivers", "Driver browsing");
    const invocation = await this.getInvocation();
    const command = leaseProtocol.buildRoleDriversCommand(await this.getSessionInterpreter(invocation));
    const { stdout } = await this.run(protocol.buildShellArgs(client, lease, command), {
      invocation,
      timeoutMs: 120_000,
    });
    return leaseProtocol.parseRoleDrivers(stdout);
  }

  /**
   * The Python a command inside a lease session should run with: the
   * interpreter `jmp` itself runs from, so that `jumpstarter` and the
   * project's dependencies import. In `<python> -m jumpstarter_cli` mode
   * that is the command; beside a `jmp` executable it is the `python` of the
   * same directory (a virtual environment's `bin`), else the active
   * interpreter when known, else a bare "python".
   */
  async getSessionInterpreter(given?: JmpInvocation): Promise<string> {
    const invocation = given ?? (await this.getInvocation());
    if (invocation.prefixArgs.length > 0) {
      return invocation.command;
    }
    const python = await this.pythonPathOrEmpty();
    if (python) {
      return python;
    }
    const beside = path.join(
      path.dirname(invocation.command),
      process.platform === "win32" ? "python.exe" : "python",
    );
    return path.isAbsolute(invocation.command) && fsSync.existsSync(beside) ? beside : "python";
  }

  /**
   * `jmp create lease ... -o name`. Tags always include
   * created-by=vscode. Resolves to the new lease name.
   * Lease acquisition can block while waiting for an exporter, so the
   * timeout is generous.
   */
  async createLease(client: string, opts: CreateLeaseOptions): Promise<string> {
    const { stdout } = await this.run(protocol.buildCreateLeaseArgs(client, opts), {
      timeoutMs: 120_000,
    });
    return stdout.trim();
  }

  /** `jmp delete leases <name> --client <client>` */
  async deleteLease(client: string, name: string): Promise<void> {
    await this.run(protocol.buildDeleteLeaseArgs(client, name));
  }

  /** `jmp update lease <name> --duration <duration> --client <client>` */
  async updateLease(client: string, name: string, duration: string): Promise<void> {
    await this.run(protocol.buildUpdateLeaseArgs(client, name, duration));
  }

  /**
   * `jmp config client list -o json` — tokens come back REDACTED; keep it that way.
   *
   * Shared: every view asks for it on every refresh (see `sharedRead`).
   */
  listClients(): Promise<ClientConfigList> {
    return this.sharedRead("clients", () =>
      this.runJson<ClientConfigList>(protocol.buildListClientsArgs()),
    );
  }

  /**
   * One answer for the views that ask the same local question in the same refresh.
   *
   * The client list and a client's auth status are read from the config
   * directory, and each view (clients, leases, exporters, status bar) asks for
   * both whenever it refreshes: four `jmp` processes each, for one answer. A
   * call made while another is running, or within `SHARED_READ_MS` of its
   * answer, gets that answer. `forgetSharedReads` drops them when the config
   * directory changes; a failure is never kept.
   */
  private sharedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
    const known = this.sharedReads.get(key);
    if (known && Date.now() < known.until) {
      return known.value as Promise<T>;
    }
    const value = read();
    const entry = { value, until: Number.POSITIVE_INFINITY };
    this.sharedReads.set(key, entry);
    value.then(
      () => {
        entry.until = Date.now() + SHARED_READ_MS;
      },
      () => {
        if (this.sharedReads.get(key) === entry) {
          this.sharedReads.delete(key);
        }
      },
    );
    return value;
  }

  /** Read the client list and auth status afresh next time (the config directory changed). */
  forgetSharedReads(): void {
    this.sharedReads.clear();
  }

  /**
   * `jmp config exporter list -o json`, reduced to alias/name/path.
   *
   * Unlike the client list, this output still contains exporter tokens, so the
   * response is narrowed here and the raw objects are never returned, stored
   * or logged.
   */
  async listExporterConfigs(): Promise<ExporterConfigRef[]> {
    const res = await this.runJson<{
      items?: { alias?: string; path?: string; metadata?: { name?: string } }[];
    }>(protocol.buildListExporterConfigsArgs());
    return (res.items ?? [])
      .filter((item) => item.alias && item.path)
      .map((item) => ({
        alias: item.alias as string,
        path: item.path as string,
        name: item.metadata?.name ?? (item.alias as string),
      }));
  }

  /** `jmp config client use <alias>` */
  async useClient(alias: string): Promise<void> {
    try {
      await this.run(protocol.buildUseClientArgs(alias));
    } finally {
      this.forgetSharedReads();
    }
  }

  /** `jmp config client delete <alias>` */
  async deleteClientConfig(alias: string): Promise<void> {
    try {
      await this.run(protocol.buildDeleteClientArgs(alias));
    } finally {
      this.forgetSharedReads();
    }
  }

  /** `jmp auth status --client <client> -o json` — local check, never interactive. */
  authStatus(client: string): Promise<AuthStatus> {
    return this.sharedRead(`auth:${client}`, () =>
      this.runJson<AuthStatus>(protocol.buildAuthStatusArgs(client)),
    );
  }

  /**
   * Guard for background/remote work: checks auth status and throws
   * JmpError("auth-expired") when the token is expired/missing/invalid, so a
   * background jmp call can never trigger an interactive browser re-auth.
   * Returns the status ("valid" | "expiring-soon" | "no-expiry") otherwise.
   */
  async ensureAuthValid(client: string): Promise<AuthStatus> {
    const status = await this.authStatus(client);
    if (
      status.status === "expired" ||
      status.status === "no-token" ||
      status.status === "invalid-token"
    ) {
      throw new JmpError(
        "auth-expired",
        `Client '${client}' needs re-authentication (${status.status})`,
      );
    }
    return status;
  }

  /** `jmp driver list -o json` — locally installed driver packages. */
  async driverList(): Promise<DriverInfo[]> {
    const res = await this.runJson<DriverListResponse>(protocol.buildDriverListArgs());
    return res.drivers ?? [];
  }

  /**
   * `jmp driver schema -o json` — per-driver config keys as JSON Schema.
   *
   * Loading every driver class is comparatively slow (seconds on a large
   * environment), so callers should cache the result per interpreter.
   *
   * The version says too little about a development build: one from before
   * the command refuses it. That is remembered, so the capability is off (YAML
   * completion from the bundled schemas, driver packages typed by hand) until
   * the next probe, which another interpreter or another `jmp` brings.
   */
  async driverSchemas(): Promise<DriverSchema[]> {
    this.requireCapability("driverSchema", "jmp driver schema");
    try {
      const res = await this.runJson<DriverSchemaResponse>(protocol.buildDriverSchemaArgs(), {
        timeoutMs: 120_000,
      });
      return res.drivers ?? [];
    } catch (err) {
      if (err instanceof JmpError && err.kind === "usage" && /no such command/i.test(err.stderr)) {
        this.driverSchemaUnsupported = true;
        this.log("this jmp has no `driver schema`: YAML completion uses the bundled schemas alone");
      }
      throw err;
    }
  }

  /** `jmp describe exporter <name> -o json --client <client>` */
  describeExporter(client: string, name: string): Promise<unknown> {
    return this.runJson<unknown>(protocol.buildDescribeArgs("exporter", name, client));
  }

  /** `jmp describe lease <name> -o json --client <client>` */
  describeLease(client: string, name: string): Promise<unknown> {
    return this.runJson<unknown>(protocol.buildDescribeArgs("lease", name, client));
  }

  /** `jmp describe client <name> -o json` */
  describeClient(name: string): Promise<unknown> {
    return this.runJson<unknown>(protocol.buildDescribeArgs("client", name));
  }

  /**
   * `jmp describe lease <name> --drivers -o json --client <client>` —
   * drivers + recursive `j` CLI tree of the lease session. Establishing the
   * session can be slow, hence the longer timeout.
   */
  async describeLeaseWithDrivers(client: string, name: string): Promise<LeaseWithDrivers> {
    this.requireCapability("describeDrivers", "jmp describe lease --drivers");
    const args = protocol.buildDescribeLeaseWithDriversArgs(client, name);
    try {
      return await this.runJson<LeaseWithDrivers>(args, { timeoutMs: 120_000 });
    } catch (err) {
      // Older IDE integration builds expose this as --devices / {devices}.
      // Only retry an explicit unknown-option error, never a session failure.
      if (!(err instanceof JmpError) || err.kind !== "usage" ||
          !/No such option: --drivers\b/.test(err.stderr)) {
        throw err;
      }
      this.requireCapability("describeDrivers", "jmp describe lease --drivers");
      const legacy = await this.runJson<{
        lease: Lease;
        devices: LeaseWithDrivers["driver_tree"];
      }>(args.map((arg) => arg === "--drivers" ? "--devices" : arg), { timeoutMs: 120_000 });
      return { lease: legacy.lease, driver_tree: legacy.devices };
    }
  }

  // -------------------------------------------------------------------------
  // Cluster administration
  //
  // These use the user's kubeconfig instead of a client token, so they see
  // every resource in a namespace rather than the ones one client can reach.
  // -------------------------------------------------------------------------

  /** `jmp admin get <kind> -o json`, unwrapped to the list's items. */
  private async adminList<T>(kind: protocol.AdminKind, options: AdminOptions): Promise<T[]> {
    const res = await this.runJson<AdminList<T>>(protocol.buildAdminGetArgs(kind, options));
    return res.items ?? [];
  }

  adminClients(options: AdminOptions = {}): Promise<AdminClient[]> {
    return this.adminList<AdminClient>("client", options);
  }

  adminExporters(options: AdminOptions = {}): Promise<AdminExporter[]> {
    return this.adminList<AdminExporter>("exporter", options);
  }

  adminLeases(options: AdminOptions = {}): Promise<AdminLease[]> {
    return this.adminList<AdminLease>("lease", options);
  }

  async adminExporterSets(options: AdminOptions = {}): Promise<AdminExporterSet[]> {
    this.requireCapability("adminExporterSets", "jmp admin get exporterset");
    return this.adminList<AdminExporterSet>("exporterset", options);
  }

  /**
   * Whether this machine can administer a Jumpstarter cluster: a kubeconfig
   * that resolves, and the Jumpstarter CRDs served by the cluster it points
   * at. Listing clients answers both at once. Never throws.
   */
  async probeAdmin(options: AdminOptions = {}): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.adminClients(options);
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[admin] unavailable: ${reason}`);
      return { ok: false, reason };
    }
  }

  /**
   * `jmp admin import <kind> <name> -o path` — write the config the cluster
   * generated for an existing client or exporter to disk, and return where.
   *
   * The config carries a token, so it is fetched straight into a file by the
   * CLI: the credential never passes through this process.
   */
  async adminImportConfig(
    kind: "client" | "exporter",
    name: string,
    options: AdminOptions = {},
    access: protocol.ImportDriverAccess & { out?: string } = {},
  ): Promise<string> {
    const { stdout } = await this.run(
      protocol.buildAdminImportArgs(kind, name, options, access),
      { timeoutMs: 60_000 },
    );
    return stdout.trim();
  }

  /** `jmp admin apply -f <file> -o json` — create or update cluster resources. */
  async adminApply(
    files: readonly string[],
    options: AdminOptions = {},
    opts: { dryRun?: boolean } = {},
  ): Promise<AppliedResource[]> {
    this.requireCapability("adminApply", "jmp admin apply");
    const res = await this.runJson<AdminList<AppliedResource>>(
      protocol.buildAdminApplyArgs(files, options, opts),
      { timeoutMs: 60_000 },
    );
    return res.items ?? [];
  }

  /**
   * Build the argv for `jmp shell` for use in a VS Code terminal (this
   * service never runs shell itself — it is interactive). Returns the
   * executable and full args; e.g.
   *   const { command, args } = await jmp.getShellCommand(client, lease);
   *   vscode.window.createTerminal({ name, shellPath: command, shellArgs: args });
   * Pass `command` to run something inside the lease session instead of an
   * interactive shell (e.g. ["j", "power", "on"] or ["python", "test.py"]).
   */
  async getShellCommand(
    client: string,
    lease: string,
    command?: readonly string[],
  ): Promise<{ command: string; args: string[] }> {
    const invocation = await this.getInvocation();
    return {
      command: invocation.command,
      args: [...invocation.prefixArgs, ...protocol.buildShellArgs(client, lease, command)],
    };
  }

  /**
   * Argv for a session against a standalone exporter (no controller, no
   * lease). The passphrase is redacted wherever the argv is logged.
   */
  async getDirectShellCommand(
    options: protocol.DirectConnectOptions,
    command?: readonly string[],
  ): Promise<{ command: string; args: string[] }> {
    const invocation = await this.getInvocation();
    return {
      command: invocation.command,
      args: [...invocation.prefixArgs, ...protocol.buildDirectShellArgs(options, command)],
    };
  }

  /** Argv for serving a locally configured exporter and opening a session. */
  async getLocalExporterShellCommand(
    alias: string,
    command?: readonly string[],
  ): Promise<{ command: string; args: string[] }> {
    const invocation = await this.getInvocation();
    return {
      command: invocation.command,
      args: [...invocation.prefixArgs, ...protocol.buildLocalExporterShellArgs(alias, command)],
    };
  }

  /**
   * Terminal environment that puts the active virtual environment on PATH.
   *
   * Two reasons: inside the lease session `python`, `pytest` and `j` should
   * resolve to the environment jmp itself came from; and presenting the
   * terminal as already-activated stops the Python extension from typing an
   * activation command into a shell that is already in that environment.
   *
   * Returns undefined when the interpreter is not a virtual environment, so
   * a system or conda interpreter is left alone.
   */
  async getTerminalEnv(): Promise<Record<string, string> | undefined> {
    const interpreter = await this.pythonPathOrEmpty();
    if (!interpreter) {
      return undefined;
    }
    const binDir = path.dirname(interpreter);
    const venvRoot = path.dirname(binDir);
    try {
      await fs.stat(path.join(venvRoot, "pyvenv.cfg"));
    } catch {
      return undefined;
    }
    const currentPath = process.env.PATH ?? "";
    return {
      VIRTUAL_ENV: venvRoot,
      PATH: currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir,
    };
  }

  /**
   * Build the argv to run a Python file inside a lease session (via
   * `jmp shell ... -- <interpreter> <file>`), for use in a VS Code terminal.
   *
   * The lease session inherits PATH unchanged, so a bare "python" would
   * resolve to the system interpreter — not the active environment jmp was
   * invoked from — and the script could not import the jumpstarter client
   * library or project dependencies. Use the resolved interpreter path:
   * in python-module mode that is the invocation command itself; with a
   * jmpPath override, fall back to the active interpreter when known, else
   * a bare "python".
   */
  async getRunFileCommand(
    client: string,
    lease: string,
    filePath: string,
  ): Promise<{ command: string; args: string[] }> {
    const invocation = await this.getInvocation();
    const interpreter = await this.getSessionInterpreter(invocation);
    return {
      command: invocation.command,
      args: [
        ...invocation.prefixArgs,
        ...protocol.buildShellArgs(client, lease, [interpreter, filePath]),
      ],
    };
  }

  dispose(): void {
    this.interpreterEmitter.dispose();
    this.availabilityEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
