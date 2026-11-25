/**
 * The bridge of a lease: `jumpstarter-web bridge` running inside the lease,
 * with this process at the other end of its pipes (docs/bridge.md of
 * jumpstarter-web).
 *
 * One process per lease, started the first time a view of the lease is asked
 * for and kept while any is open. It listens on nothing: no port to find, to
 * forward or to map in a workspace that runs in the browser. Each view gets a
 * port of its own from the hub, and takes what it had open with it when it
 * closes.
 *
 * The extension carries its own copy of Jumpstarter Web (the `python`
 * directory, see scripts/sync-jumpstarter-web.sh) and puts it on PYTHONPATH of
 * the environment's own interpreter: everything it imports is something
 * Jumpstarter itself depends on, so any environment that has Jumpstarter can be
 * used with nothing installed into it.
 */

import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import * as path from "path";
import {
  BridgeFrameDecoder,
  BridgeHub,
  BridgeIncoming,
  BridgePort,
  BRIDGE_PROTOCOL,
  encodeBridgeFrame,
} from "../vendor/jumpstarter-api/bridge";
import { buildShellArgs, shellQuote } from "./jmpProtocol";
import type { JmpService } from "./jmpService";

export type BridgeReady = Extract<BridgeIncoming, { event: "ready" }> & { files?: Record<string, string> };

/** How long a bridge may take to say it is ready: the lease's hooks run first. */
export const BRIDGE_START_TIMEOUT_MS = 120_000;

export interface LeaseBridge {
  /** What the bridge said when it started: its mode, its roles, where its files are. */
  ready: BridgeReady;
  /** A port for one view. */
  port(): BridgePort;
  /** Ports in use: the bridge is ended when the last closes. */
  readonly ports: number;
}

/** The command a bridge is started with inside the lease, and the directory that goes on PYTHONPATH. */
export function bridgeCommand(python: string): string[] {
  return [python, "-m", "jumpstarter_web", "bridge"];
}

/** PYTHONPATH with the extension's own copy of Jumpstarter Web first. */
export function withBundle(bundle: string | undefined, existing: string | undefined): string | undefined {
  if (!bundle) {
    return existing;
  }
  return existing ? `${bundle}${path.delimiter}${existing}` : bundle;
}

function key(client: string, lease: string): string {
  return `${client}\n${lease}`;
}

interface Running {
  process: ChildProcess;
  hub: BridgeHub;
  ready: BridgeReady;
  ports: Set<BridgePort>;
  /** Ends the bridge a moment after its last view closed, unless another opened meanwhile. */
  idle?: NodeJS.Timeout;
}

export class LeaseBridges {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<Running>>();
  private readonly ended = new Set<(client: string, lease: string) => void>();

  /**
   * @param bundle the extension's `python` directory, if it has one
   * @param linger how long a bridge with no view is kept, for the next one
   */
  constructor(
    private readonly jmp: JmpService,
    readonly bundle: string | undefined,
    private readonly linger = 30_000,
  ) {}

  /** The extension's own copy of Jumpstarter Web, when it carries one. */
  static bundleIn(extensionPath: string): string | undefined {
    const dir = path.join(extensionPath, "python");
    return existsSync(path.join(dir, "jumpstarter_web")) ? dir : undefined;
  }

  /** Hears of a bridge that ended (its lease did, or its process). */
  onEnded(listener: (client: string, lease: string) => void): { dispose(): void } {
    this.ended.add(listener);
    return { dispose: () => this.ended.delete(listener) };
  }

  /** A port on the lease's bridge, which is started if this window has none. Concurrent requests share one start. */
  async open(client: string, lease: string): Promise<{ ready: BridgeReady; port: BridgePort }> {
    const id = key(client, lease);
    let running = this.running.get(id);
    if (!running || running.process.exitCode !== null) {
      let pending = this.starting.get(id);
      if (!pending) {
        pending = this.start(client, lease).finally(() => this.starting.delete(id));
        this.starting.set(id, pending);
      }
      running = await pending;
    }
    if (running.idle) {
      clearTimeout(running.idle);
      running.idle = undefined;
    }
    const inner = running.hub.port();
    const entry = running;
    const port: BridgePort = {
      send: (message) => inner.send(message),
      subscribe: (listener) => inner.subscribe(listener),
      close: () => {
        inner.close();
        if (entry.ports.delete(port) && entry.ports.size === 0) {
          entry.idle = setTimeout(() => this.stop(client, lease), this.linger);
        }
      },
    };
    running.ports.add(port);
    return { ready: running.ready, port };
  }

  /** Whether this window has a bridge for the lease. */
  has(client: string, lease: string): boolean {
    const running = this.running.get(key(client, lease));
    return running !== undefined && running.process.exitCode === null;
  }

  stop(client: string, lease: string): void {
    const running = this.running.get(key(client, lease));
    if (!running) {
      return;
    }
    if (running.idle) {
      clearTimeout(running.idle);
    }
    // gone for this window from now on: the next view of the lease starts another
    this.running.delete(key(client, lease));
    running.hub.end("the bridge of the lease was stopped");
    for (const listener of [...this.ended]) {
      listener(client, lease);
    }
    // the end of its input is the end of a bridge; the group, in case the shell around it lingers
    running.process.stdin?.end();
    const child = running.process;
    setTimeout(() => {
      if (child.exitCode !== null) {
        return;
      }
      try {
        if (child.pid !== undefined && process.platform !== "win32") {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill();
        }
      } catch {
        child.kill();
      }
    }, 3000).unref();
  }

  /** Ends every bridge of this window; how many there were. */
  stopAll(): number {
    const ids = [...this.running.keys()];
    for (const id of ids) {
      const [client, lease] = id.split("\n");
      this.stop(client, lease);
    }
    return ids.length;
  }

  dispose(): void {
    this.stopAll();
  }

  private async start(client: string, lease: string): Promise<Running> {
    const invocation = await this.jmp.getInvocation();
    const python = await this.jmp.getSessionInterpreter(invocation);
    const args = [...invocation.prefixArgs, ...buildShellArgs(client, lease, bridgeCommand(python))];
    this.jmp.log(`bridge: ${shellQuote([invocation.command, ...args])}`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...(await this.jmp.getTerminalEnv()), NO_COLOR: "1" };
    const pythonPath = withBundle(this.bundle, env.PYTHONPATH);
    if (pythonPath !== undefined) {
      env.PYTHONPATH = pythonPath;
    }
    const child = spawn(invocation.command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const id = key(client, lease);

    return new Promise<Running>((resolve, reject) => {
      const decoder = new BridgeFrameDecoder();
      const hub = new BridgeHub((message) => {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(encodeBridgeFrame(message));
        }
      });
      let settled = false;
      let errors = "";
      const fail = (message: string): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(message));
        }
      };
      const timer = setTimeout(() => {
        fail(`The lease's bridge did not start within ${BRIDGE_START_TIMEOUT_MS / 1000} s.\n${tail(errors)}`);
        child.kill();
      }, BRIDGE_START_TIMEOUT_MS);

      child.stdin?.on("error", () => undefined); // a bridge that is gone: its close says so
      child.stdout?.on("data", (chunk: Buffer) => {
        let messages: BridgeIncoming[];
        try {
          messages = decoder.push(chunk);
        } catch (err) {
          this.jmp.log(`bridge of ${lease}: ${err instanceof Error ? err.message : String(err)}`);
          child.kill();
          return;
        }
        for (const message of messages) {
          if (message.event === "ready" && !settled) {
            if (message.protocol !== BRIDGE_PROTOCOL) {
              fail(`The lease's bridge speaks ${message.protocol}, and this extension ${BRIDGE_PROTOCOL}.`);
              child.kill();
              return;
            }
            settled = true;
            clearTimeout(timer);
            hub.receive(message);
            const running: Running = { process: child, hub, ready: message, ports: new Set() };
            this.running.set(id, running);
            resolve(running);
            continue;
          }
          hub.receive(message);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        // what the lease's shell and the drivers' clients say: kept for a failure to start, logged after
        const text = chunk.toString();
        if (settled) {
          for (const line of text.split("\n")) {
            if (line.trim()) {
              this.jmp.log(`bridge of ${lease}: ${line.trimEnd()}`);
            }
          }
        } else {
          errors = (errors + text).slice(-8000);
        }
      });
      child.on("error", (err) => fail(`Could not run jmp: ${err.message}`));
      child.on("close", (code) => {
        hub.end(`the bridge of the lease ended (${code})`);
        if (this.running.get(id)?.process === child) {
          this.running.delete(id);
          this.jmp.log(`bridge of ${lease} exited (${code})`);
          for (const listener of [...this.ended]) {
            listener(client, lease);
          }
        }
        const missing = /No module named '?jumpstarter_web|No such command '?bridge/i.test(errors);
        fail(
          missing
            ? "This environment's Jumpstarter Web has no bridge, and the extension carries none: install a current `jumpstarter-web` next to jumpstarter."
            : `The lease's bridge exited (${code}) before it was ready.\n${tail(errors)}`,
        );
      });
    });
  }
}

function tail(output: string, lines = 8): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}
