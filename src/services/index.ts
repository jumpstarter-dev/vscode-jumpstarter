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
import { PendingLeaseStore } from "./pendingLeases";

export { JmpService, JmpError, JmpErrorKind, JmpCapabilities } from "./jmpService";
export type {
  JmpAvailability,
  JmpInvocation,
  RunResult,
  CreateLeaseOptions,
  AdminOptions,
} from "./jmpService";
export { ConfigWatcher } from "./configWatcher";
export { StatusBarManager } from "./statusBar";
export { Poller, configuredPollIntervalSeconds } from "./poller";
export type { PollerOptions } from "./poller";
export { PendingLeaseStore, describePending } from "./pendingLeases";
export type { PendingLease } from "./pendingLeases";

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
   * Fires after a lease is created, extended or ended.
   *
   * Leasing changes what the Exporters view shows as much as the Leases view
   * — an exporter becomes leased, or is recycled out of a pool — so both
   * refresh on this rather than waiting out their own poll interval.
   */
  onDidChangeLeases: vscode.Event<void>;
  /** Announce a lease change; see onDidChangeLeases. */
  notifyLeasesChanged(): void;
  /**
   * Lease requests that are still in flight, so the lease views can show one
   * before the controller has bound an exporter to it.
   */
  pendingLeases: PendingLeaseStore;
  /**
   * Create a Poller owned by the calling feature. The feature must push the
   * returned poller onto context.subscriptions (it is a Disposable) and call
   * start() / setVisible() itself.
   */
  createPoller(options: PollerOptions): Poller;
}
