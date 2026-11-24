/**
 * Pure logic for the test-run lease pin feature (see ../testing.ts).
 *
 * No vscode imports — everything here is unit-tested under plain node via
 * `pnpm run test:unit` (src/test/unit/testingPin.test.ts).
 *
 * Mechanism recap: pinning a lease exports JMP_LEASE=<lease-name> and
 * JMP_CLIENT=<client-alias> into the extension's EnvironmentVariableCollection,
 * so new terminals and (in current VS Code builds) Python-extension test runs
 * inherit them. The jumpstarter client library honors JMP_LEASE: when
 * `ClientConfigV1Alpha1.lease()` (used by the JumpstarterTest pytest fixture)
 * sees JMP_LEASE it ATTACHES to that existing lease and does NOT release it on
 * exit — tests reuse the pinned hardware instead of acquiring/releasing a
 * fresh lease per run.
 */

import { AuthStatusValue, Lease, isLeaseUsable, leaseRemainingSeconds } from "../../types";
import { leaseTarget } from "../leases/members";

/** workspaceState key holding the serialized TestPin. */
export const PIN_STATE_KEY = "jumpstarter.testing.pin";

/** Env var the jumpstarter client library reads to attach to an existing lease. */
export const ENV_LEASE_VAR = "JMP_LEASE";

/**
 * Env var carrying the client alias the pinned lease belongs to. The current
 * jumpstarter CLI does not read a JMP_CLIENT variable yet (the JumpstarterTest
 * fixture loads the "default" alias); it is exported for forward compatibility
 * and for user scripts/wrappers that want to pass `--client "$JMP_CLIENT"`.
 */
export const ENV_CLIENT_VAR = "JMP_CLIENT";

/** Description shown by VS Code next to the injected environment variables. */
export const ENV_COLLECTION_DESCRIPTION =
  "Jumpstarter test-run lease pin: terminals and test runs attach to the pinned lease via JMP_LEASE (client alias in JMP_CLIENT)";

/** A pinned lease, persisted in workspaceState. */
export interface TestPin {
  /** Local client config alias the lease was pinned under. */
  clientAlias: string;
  /** Lease resource name (the value exported as JMP_LEASE). */
  leaseName: string;
  /** ISO timestamp of when the pin was created. */
  pinnedAt: string;
}

export function makePin(clientAlias: string, leaseName: string, now: Date = new Date()): TestPin {
  return { clientAlias, leaseName, pinnedAt: now.toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate a value read back from workspaceState. Returns null for anything
 * that is not a well-formed pin (so a corrupt/old value degrades to "no pin").
 */
export function parseStoredPin(raw: unknown): TestPin | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { clientAlias, leaseName, pinnedAt } = raw;
  if (typeof clientAlias !== "string" || clientAlias.length === 0) {
    return null;
  }
  if (typeof leaseName !== "string" || leaseName.length === 0) {
    return null;
  }
  return {
    clientAlias,
    leaseName,
    pinnedAt: typeof pinnedAt === "string" ? pinnedAt : "",
  };
}

/** The exact env vars a pin injects, in a deterministic order. */
export function pinEnvironment(pin: TestPin): ReadonlyArray<{ name: string; value: string }> {
  return [
    { name: ENV_LEASE_VAR, value: pin.leaseName },
    { name: ENV_CLIENT_VAR, value: pin.clientAlias },
  ];
}

/** Shorten a lease name (often a UUID) for the status bar. */
export function shortLeaseName(name: string, max = 12): string {
  if (name.length <= max) {
    return name;
  }
  return `${name.slice(0, Math.max(1, max - 1))}…`;
}

/** Status bar label shown while a pin is active. */
export function pinStatusBarText(pin: TestPin): string {
  return `$(beaker) Tests → lease ${shortLeaseName(pin.leaseName)}`;
}

/** Status bar tooltip (plain text; never include tokens). */
export function pinStatusBarTooltip(pin: TestPin): string {
  const lines = [
    `Jumpstarter test runs are pinned to lease ${pin.leaseName}`,
    `Client: ${pin.clientAlias}`,
  ];
  if (pin.pinnedAt) {
    lines.push(`Pinned at: ${pin.pinnedAt}`);
  }
  lines.push("New terminals and test runs get JMP_LEASE / JMP_CLIENT.");
  lines.push("Click to switch lease or clear the pin.");
  return lines.join("\n");
}

/** Whether a lease is worth offering in the pin picker / keeping pinned. */
export function isLeasePinnable(lease: Lease): boolean {
  return isLeaseUsable(lease.status) || lease.status === "Waiting";
}

// ---------------------------------------------------------------------------
// Restore-time validation
// ---------------------------------------------------------------------------

/** What the feature managed to find out while validating a restored pin. */
export type RestoreCheck =
  /** Lease listing succeeded for the pin's client. */
  | { kind: "leases"; leases: Lease[] }
  /** Auth is not usable for background calls — validation impossible. */
  | { kind: "auth-blocked"; status: AuthStatusValue }
  /** The listing call failed with a JmpError. */
  | { kind: "error"; errorKind: string; message: string };

export type PinDecision = { action: "keep" } | { action: "clear"; reason: string };

/**
 * Decide whether a pin restored from workspaceState is still valid.
 *
 * Policy: only clear when we POSITIVELY know the pin is dead (lease gone /
 * ended / expired, or the client config no longer exists). Connection
 * failures, auth problems and unknown errors keep the pin — clearing a
 * usable pin is worse than keeping a stale one for one more session.
 */
export function decideRestoredPin(pin: TestPin, check: RestoreCheck): PinDecision {
  switch (check.kind) {
    case "leases": {
      const lease = check.leases.find((l) => l.name === pin.leaseName);
      if (!lease) {
        return {
          action: "clear",
          reason: `lease ${pin.leaseName} no longer exists on client ${pin.clientAlias}`,
        };
      }
      if (lease.status === "Expired" || lease.status === "Ended") {
        return {
          action: "clear",
          reason: `lease ${pin.leaseName} is ${lease.status.toLowerCase()}`,
        };
      }
      // In-Use / Waiting / Unknown: keep.
      return { action: "keep" };
    }
    case "auth-blocked":
      // Cannot verify without triggering an interactive login — keep the pin.
      return { action: "keep" };
    case "error":
      // A nonexistent client alias classifies as "unknown" with a
      // "Failed to load config: ... does not exist" message (foundation note 5a).
      if (check.errorKind === "unknown" && /does not exist/i.test(check.message)) {
        return {
          action: "clear",
          reason: `client config "${pin.clientAlias}" no longer exists`,
        };
      }
      return { action: "keep" };
  }
}

// ---------------------------------------------------------------------------
// Command-argument coercion
// ---------------------------------------------------------------------------

/** What we could extract from the argument passed to jumpstarter.pinLeaseForTests. */
export interface CoercedPinArgument {
  leaseName?: string;
  clientAlias?: string;
}

function looksLikeLease(value: Record<string, unknown>): boolean {
  return (
    typeof value.name === "string" &&
    (typeof value.exporter_name === "string" ||
      typeof value.duration === "number" ||
      "effective_begin_time" in value)
  );
}

/**
 * Tolerantly extract a lease name and client alias from whatever a tree row
 * (built by the sibling leases feature, shape unknown to us) or a palette
 * invocation passes:
 *   - a plain string          -> lease name
 *   - a Lease object          -> its .name (its .client field is the
 *                                controller-side client resource name, NOT a
 *                                local alias, so it is deliberately ignored)
 *   - a node with .lease      -> .lease.name, plus .client/.clientAlias as alias
 *   - a node with .leaseName  -> used directly
 * Anything unrecognized yields {} and the command falls back to quick picks.
 */
export function coercePinArgument(arg: unknown): CoercedPinArgument {
  if (typeof arg === "string") {
    return arg.length > 0 ? { leaseName: arg } : {};
  }
  if (!isRecord(arg)) {
    return {};
  }
  const out: CoercedPinArgument = {};
  const nested = arg.lease;
  if (isRecord(nested) && typeof nested.name === "string" && nested.name.length > 0) {
    out.leaseName = nested.name;
  } else if (typeof arg.leaseName === "string" && arg.leaseName.length > 0) {
    out.leaseName = arg.leaseName;
  } else if (looksLikeLease(arg)) {
    out.leaseName = arg.name as string;
  }
  if (typeof arg.clientAlias === "string" && arg.clientAlias.length > 0) {
    out.clientAlias = arg.clientAlias;
  } else if (
    typeof arg.client === "string" &&
    arg.client.length > 0 &&
    !looksLikeLease(arg)
  ) {
    // On a tree node, .client is plausibly the local alias; on a raw Lease it
    // is the controller-side client resource name, so it is skipped above.
    out.clientAlias = arg.client;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quick pick items
// ---------------------------------------------------------------------------

/** Human-friendly remaining-time string ("1h 5m left", "3m left", "over-run"). */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) {
    return "not started";
  }
  if (seconds <= 0) {
    return "over-run";
  }
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m left`;
  }
  if (totalMinutes > 0) {
    return `${minutes}m left`;
  }
  return "<1m left";
}

/** Data for one entry of the lease quick pick (vscode-free; the feature maps it to QuickPickItem). */
export interface LeasePickEntry {
  leaseName: string;
  label: string;
  description: string;
  /** True when this lease is the currently pinned one. */
  picked: boolean;
}

/**
 * Build picker entries for the pinnable (In-Use / Waiting) leases, currently
 * pinned lease first, then by name for stability.
 */
export function buildLeasePickEntries(
  leases: Lease[],
  pinnedLeaseName?: string,
  now: Date = new Date(),
): LeasePickEntry[] {
  return leases
    .filter(isLeasePinnable)
    .sort((a, b) => {
      if (a.name === pinnedLeaseName) {
        return -1;
      }
      if (b.name === pinnedLeaseName) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    })
    .map((lease) => {
      // (a lease with members is named by its template, or its roles)
      const parts = [lease.status, leaseTarget(lease) || lease.selector || "(no exporter)"];
      if (isLeaseUsable(lease.status)) {
        parts.push(formatRemaining(leaseRemainingSeconds(lease, now)));
      }
      return {
        leaseName: lease.name,
        label: lease.name,
        description: parts.join(" · "),
        picked: lease.name === pinnedLeaseName,
      };
    });
}
