/**
 * Shared services passed to every feature module.
 *
 * Feature modules live in src/features/<name>.ts and export
 *   export function register<Feature>(context: vscode.ExtensionContext, services: Services): void
 * They are wired up in src/extension.ts.
 */

import * as vscode from "vscode";
import { JmpService } from "./jmpService";
import { ConfigWatcher } from "./configWatcher";
import { StatusBarManager } from "./statusBar";
import { Poller, PollerOptions } from "./poller";

export { JmpService, JmpError, JmpErrorKind, JmpCapabilities } from "./jmpService";
export type { JmpAvailability, JmpInvocation, RunResult, CreateLeaseOptions } from "./jmpService";
export { ConfigWatcher } from "./configWatcher";
export { StatusBarManager } from "./statusBar";
export { Poller, configuredPollIntervalSeconds } from "./poller";
export type { PollerOptions } from "./poller";

export interface Services {
  /** The CLI bridge — every jmp call goes through this. */
  jmp: JmpService;
  /** Watches $JMP_CLIENT_CONFIG_HOME / ~/.config/jumpstarter for external changes. */
  configWatcher: ConfigWatcher;
  /** Status bar item showing active client + auth state; call refresh() after mutations. */
  statusBar: StatusBarManager;
  /** Shared "Jumpstarter" output channel for logs/warnings. */
  output: vscode.OutputChannel;
  /**
   * Create a Poller owned by the calling feature. The feature must push the
   * returned poller onto context.subscriptions (it is a Disposable) and call
   * start() / setVisible() itself.
   */
  createPoller(options: PollerOptions): Poller;
}
