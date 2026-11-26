/**
 * Leases the extension has asked for but not yet been given.
 *
 * `jmp create lease` blocks until the controller binds an exporter, which can
 * take a while when a pool has to provision one first. Without this the views
 * show nothing at all during that wait: the lease does not exist yet, so
 * neither listing returns it, and the only sign of progress is a spinner in a
 * corner. Recording the request lets both lease views show it immediately, and
 * drop it as soon as the real lease appears (or the attempt fails).
 *
 * The row's shape and text live in pendingLeasesModel.ts, which is free of
 * "vscode" so it can be unit-tested.
 */

import * as vscode from "vscode";
import { PendingLease } from "./pendingLeasesModel";

export { describePending, describeReleasing, leasesStillPending, waitForLease, waitForRelease } from "./pendingLeasesModel";
export type { LeaseWaitOutcome, PendingLease } from "./pendingLeasesModel";

export class PendingLeaseStore implements vscode.Disposable {
  private readonly entries = new Map<string, PendingLease>();
  private sequence = 0;

  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever a request starts or settles. */
  readonly onDidChange: vscode.Event<void> = this.emitter.event;

  /** Record a lease request; returns the id to settle it with. */
  begin(client: string, label: string, now = Date.now()): string {
    const id = `pending-${++this.sequence}`;
    this.entries.set(id, { id, client, label, startedAt: now });
    this.emitter.fire();
    return id;
  }

  /**
   * The controller made the lease of a request: the request stays shown, in the
   * place of that lease's own row, until the lease is held (see `end`).
   */
  named(id: string, leaseName: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.leaseName !== leaseName) {
      this.entries.set(id, { ...entry, leaseName });
      this.emitter.fire();
    }
  }

  /** Withdraw a request, whether it succeeded or failed. */
  end(id: string): void {
    if (this.entries.delete(id)) {
      this.emitter.fire();
    }
  }

  /** Outstanding requests, oldest first. */
  all(): PendingLease[] {
    return [...this.entries.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Outstanding requests made through one client. */
  forClient(client: string): PendingLease[] {
    return this.all().filter((entry) => entry.client === client);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
