/**
 * The shape of an in-flight lease request, and how it reads in a tree.
 *
 * Kept apart from the store so it can be unit-tested under plain Node — this
 * module must never import "vscode".
 */

export interface PendingLease {
  /** Identifies this attempt, so it can be withdrawn when it settles. */
  id: string;
  /** Client config the lease was requested through. */
  client: string;
  /** What was asked for, as the user asked for it: a name or a selector. */
  label: string;
  /** When the request went out, for an elapsed-time description. */
  startedAt: number;
}

/** "acquiring… 12s" — how long a request has been outstanding. */
export function describePending(entry: PendingLease, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - entry.startedAt) / 1000));
  return seconds > 0 ? `acquiring… ${seconds}s` : "acquiring…";
}
