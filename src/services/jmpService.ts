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
import { spawn } from "child_process";
import { PythonExtension } from "@vscode/python-extension";
import * as protocol from "./jmpProtocol";
import { JmpError, JmpCapabilities, CreateLeaseOptions } from "./jmpProtocol";
import {
  AuthStatus,
  ClientConfigList,
  DriverInfo,
  DriverListResponse,
  Exporter,
  GetExportersResponse,
  GetLeasesResponse,
  JmpVersion,
  Lease,
  LeaseWithDevices,
} from "../types";

export { JmpError, JmpErrorKind, JmpCapabilities, CreateLeaseOptions } from "./jmpProtocol";

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

export interface RunResult {
  stdout: string;
  /** Raw stderr text. */
  stderr: string;
  /** Non-empty stderr lines (already logged to the output channel). */
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class JmpService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

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

  constructor(output?: vscode.OutputChannel) {
    this.output = output ?? vscode.window.createOutputChannel("Jumpstarter");
    if (!output) {
      this.disposables.push(this.output);
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("jumpstarter.jmpPath")) {
          this.interpreterEmitter.fire();
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

  /** Probe `jmp version -o json` and recompute capability flags. */
  async probe(): Promise<JmpAvailability> {
    let result: JmpAvailability;
    try {
      const invocation = await this.getInvocation();
      const version = await this.runJson<JmpVersion>(protocol.buildVersionArgs(), {
        invocation,
      });
      result = {
        kind: "ok",
        version,
        capabilities: protocol.computeCapabilities(version.gitVersion),
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

  /** `jmp get exporters --with leases,online,status -o json --client <client>` */
  async getExporters(client: string): Promise<Exporter[]> {
    const res = await this.runJson<GetExportersResponse>(protocol.buildGetExportersArgs(client));
    return (res.exporters ?? []).map(protocol.normalizeExporter);
  }

  /** `jmp get leases -o json --client <client>` (`-a` when includeEnded). */
  async getLeases(client: string, includeEnded = false): Promise<Lease[]> {
    const res = await this.runJson<GetLeasesResponse>(
      protocol.buildGetLeasesArgs(client, includeEnded),
    );
    return res.leases ?? [];
  }

  /**
   * `jmp create lease ... -o name`. Tags always include
   * jumpstarter.dev/created-by=vscode. Resolves to the new lease name.
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

  /** `jmp config client list -o json` — tokens come back REDACTED; keep it that way. */
  listClients(): Promise<ClientConfigList> {
    return this.runJson<ClientConfigList>(protocol.buildListClientsArgs());
  }

  /** `jmp config client use <alias>` */
  async useClient(alias: string): Promise<void> {
    await this.run(protocol.buildUseClientArgs(alias));
  }

  /** `jmp config client delete <alias>` */
  async deleteClientConfig(alias: string): Promise<void> {
    await this.run(protocol.buildDeleteClientArgs(alias));
  }

  /** `jmp auth status --client <client> -o json` — local check, never interactive. */
  authStatus(client: string): Promise<AuthStatus> {
    return this.runJson<AuthStatus>(protocol.buildAuthStatusArgs(client));
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
   * `jmp describe lease <name> --devices -o json --client <client>` —
   * drivers + recursive `j` CLI tree of the lease session. Establishing the
   * session can be slow, hence the longer timeout.
   */
  describeLeaseWithDevices(client: string, name: string): Promise<LeaseWithDevices> {
    return this.runJson<LeaseWithDevices>(
      protocol.buildDescribeLeaseWithDevicesArgs(client, name),
      { timeoutMs: 120_000 },
    );
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
    let interpreter: string;
    if (invocation.prefixArgs.length > 0) {
      // `<python> -m jumpstarter_cli` mode: the command IS the interpreter.
      interpreter = invocation.command;
    } else {
      const python = await this.pythonPathOrEmpty();
      interpreter = python || "python";
    }
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
