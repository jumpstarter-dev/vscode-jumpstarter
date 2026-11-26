/**
 * The shape of an in-flight lease request, how it reads in a tree, and when it
 * is over.
 *
 * Kept apart from the store so it can be unit-tested under plain Node — this
 * module must never import "vscode".
 */

import { LeaseStatus, isLeaseUsable } from "../types";

export interface PendingLease {
  /** Identifies this attempt, so it can be withdrawn when it settles. */
  id: string;
  /** Client config the lease was requested through. */
  client: string;
  /** What was asked for, as the user asked for it: a name or a selector. */
  label: string;
  /** When the request went out, for an elapsed-time description. */
  startedAt: number;
  /**
   * The lease the controller made for the request, once it has said so. The
   * lease exists from then on, but is not held yet: its row in a listing is
   * left out for as long as the request is shown in its place.
   */
  leaseName?: string;
}

/** "acquiring… 12s" — how long a request has been outstanding. */
export function describePending(entry: PendingLease, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - entry.startedAt) / 1000));
  return seconds > 0 ? `acquiring… ${seconds}s` : "acquiring…";
}

/** How long a lease that was made is waited for before the request is given up as shown. */
export const LEASE_WAIT_MS = 5 * 60_000;
/** How often the listing is read while waiting. */
export const LEASE_WAIT_INTERVAL_MS = 2_000;

/** What a listing has to say of a lease, for the wait. */
export interface ListedLease {
  name: string;
  status: LeaseStatus;
}

/**
 * How a wait for a lease ended:
 *  - `acquired`: the lease is held and can be used;
 *  - `ended`: the lease ended or expired before it was held, or was listed and is gone;
 *  - `timeout`: it is still not held after the time allowed (it may yet be: its own row says so from then on).
 */
export type LeaseWaitOutcome = "acquired" | "ended" | "timeout";

/**
 * What one reading of the listing says of a lease that is waited for;
 * `undefined` while there is nothing to say yet. `seen` is whether an earlier
 * reading had the lease: one that is not listed yet is not gone.
 */
export function leaseWaitStep(
  leaseName: string,
  leases: readonly ListedLease[],
  seen: boolean,
): { outcome?: LeaseWaitOutcome; seen: boolean } {
  const lease = leases.find((entry) => entry.name === leaseName);
  if (!lease) {
    return seen ? { outcome: "ended", seen } : { seen };
  }
  if (isLeaseUsable(lease.status)) {
    return { outcome: "acquired", seen: true };
  }
  if (lease.status === "Ended" || lease.status === "Expired") {
    return { outcome: "ended", seen: true };
  }
  return { seen: true };
}

export interface LeaseWaitOptions {
  /** Reads the client's leases. A reading that fails is passed over: the next one is asked. */
  list: () => Promise<readonly ListedLease[]>;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits until a lease that was made is held, has ended, or the time allowed is
 * over, whichever comes first. `jmp create lease` answers as soon as the lease
 * exists; an exporter is bound to it after that, and a pool with nothing warm
 * has to provision one first.
 */
export async function waitForLease(leaseName: string, options: LeaseWaitOptions): Promise<LeaseWaitOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? LEASE_WAIT_MS);
  let seen = false;
  for (;;) {
    try {
      const step = leaseWaitStep(leaseName, await options.list(), seen);
      seen = step.seen;
      if (step.outcome) {
        return step.outcome;
      }
    } catch {
      // (a listing that failed says nothing of the lease)
    }
    if (now() >= deadline) {
      return "timeout";
    }
    await sleep(options.intervalMs ?? LEASE_WAIT_INTERVAL_MS);
  }
}

/** How long a lease that was ended is waited for before its row is shown as it is again. */
export const RELEASE_WAIT_MS = 60_000;

/**
 * How a wait for the end of a lease ended:
 *  - `released`: a listing no longer has it, or has it as ended;
 *  - `timeout`: it is still held after the time allowed.
 */
export type ReleaseWaitOutcome = "released" | "timeout";

/** Whether one reading of the listing says the lease is released: it is not there, or there as ended. */
export function isReleased(leaseName: string, leases: readonly ListedLease[]): boolean {
  const lease = leases.find((entry) => entry.name === leaseName);
  return !lease || lease.status === "Ended" || lease.status === "Expired";
}

/**
 * Waits until a lease that was ended is released, or the time allowed is over,
 * whichever comes first. `jmp delete leases` answers when the controller has
 * taken the request; the exporter is given back after that.
 */
export async function waitForRelease(leaseName: string, options: LeaseWaitOptions): Promise<ReleaseWaitOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? RELEASE_WAIT_MS);
  for (;;) {
    try {
      if (isReleased(leaseName, await options.list())) {
        return "released";
      }
    } catch {
      // (a listing that failed says nothing of the lease)
    }
    if (now() >= deadline) {
      return "timeout";
    }
    await sleep(options.intervalMs ?? LEASE_WAIT_INTERVAL_MS);
  }
}

/** "releasing… 3s" — how long ago a lease was ended. */
export function describeReleasing(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return seconds > 0 ? `releasing… ${seconds}s` : "releasing…";
}

/** The leases a listing leaves out for a client: the ones whose request is still shown in their place. */
export function leasesStillPending(entries: readonly PendingLease[], client: string): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.client === client && entry.leaseName) {
      names.add(entry.leaseName);
    }
  }
  return names;
}
