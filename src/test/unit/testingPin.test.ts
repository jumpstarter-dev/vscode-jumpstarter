/**
 * Unit tests for the pure test-run lease-pin logic
 * (src/features/testing/pinModel.ts). Run with `pnpm run test:unit` —
 * plain node --test on compiled output, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildLeasePickEntries,
  coercePinArgument,
  decideRestoredPin,
  ENV_CLIENT_VAR,
  ENV_LEASE_VAR,
  formatRemaining,
  isLeasePinnable,
  makePin,
  parseStoredPin,
  pinEnvironment,
  pinStatusBarText,
  pinStatusBarTooltip,
  shortLeaseName,
  TestPin,
} from "../../features/testing/pinModel";
import { Lease, LeaseStatus } from "../../types";

function lease(overrides: Partial<Lease> & { name: string }): Lease {
  return {
    namespace: "default",
    selector: "",
    exporter: "exporters/exp-1",
    exporter_name: "exp-1",
    client: "client-resource-name",
    duration: 1800,
    effective_begin_time: null,
    effective_end_time: null,
    begin_time: null,
    tags: {},
    context: {},
    conditions: [],
    status: "In-Use" as LeaseStatus,
    ...overrides,
  };
}

const PIN: TestPin = { clientAlias: "lab", leaseName: "abc-123", pinnedAt: "2026-08-29T10:00:00Z" };

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

test("makePin + parseStoredPin round-trips", () => {
  const pin = makePin("lab", "abc-123", new Date("2026-08-29T10:00:00Z"));
  assert.deepEqual(parseStoredPin(JSON.parse(JSON.stringify(pin))), {
    clientAlias: "lab",
    leaseName: "abc-123",
    pinnedAt: "2026-08-29T10:00:00.000Z",
  });
});

test("parseStoredPin rejects malformed values", () => {
  assert.equal(parseStoredPin(undefined), null);
  assert.equal(parseStoredPin(null), null);
  assert.equal(parseStoredPin("abc-123"), null);
  assert.equal(parseStoredPin({}), null);
  assert.equal(parseStoredPin({ clientAlias: "lab" }), null);
  assert.equal(parseStoredPin({ clientAlias: "", leaseName: "x" }), null);
  assert.equal(parseStoredPin({ clientAlias: "lab", leaseName: "" }), null);
  assert.equal(parseStoredPin({ clientAlias: 1, leaseName: "x" }), null);
});

test("parseStoredPin tolerates a missing pinnedAt", () => {
  assert.deepEqual(parseStoredPin({ clientAlias: "lab", leaseName: "x" }), {
    clientAlias: "lab",
    leaseName: "x",
    pinnedAt: "",
  });
});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

test("pinEnvironment exports exactly JMP_LEASE and JMP_CLIENT", () => {
  assert.deepEqual(pinEnvironment(PIN), [
    { name: ENV_LEASE_VAR, value: "abc-123" },
    { name: ENV_CLIENT_VAR, value: "lab" },
  ]);
  assert.equal(ENV_LEASE_VAR, "JMP_LEASE");
  assert.equal(ENV_CLIENT_VAR, "JMP_CLIENT");
});

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

test("shortLeaseName truncates long names with an ellipsis", () => {
  assert.equal(shortLeaseName("short"), "short");
  assert.equal(shortLeaseName("exactly-12ch"), "exactly-12ch");
  const uuid = "08c3f13e-3d92-4741-a251-33b6b95d0a90";
  assert.equal(shortLeaseName(uuid), "08c3f13e-3d…");
  assert.equal(shortLeaseName(uuid).length, 12);
  assert.equal(shortLeaseName("abcdef", 4), "abc…");
});

test("pinStatusBarText shows the short lease name", () => {
  const pin = makePin("lab", "08c3f13e-3d92-4741-a251-33b6b95d0a90");
  assert.equal(pinStatusBarText(pin), "$(beaker) Tests → lease 08c3f13e-3d…");
});

test("pinStatusBarTooltip names lease and client, never a token", () => {
  const tooltip = pinStatusBarTooltip(PIN);
  assert.match(tooltip, /abc-123/);
  assert.match(tooltip, /lab/);
  assert.match(tooltip, /2026-08-29T10:00:00Z/);
  assert.match(tooltip, /JMP_LEASE/);
});

test("pinStatusBarTooltip omits the pinnedAt line when empty", () => {
  const tooltip = pinStatusBarTooltip({ ...PIN, pinnedAt: "" });
  assert.doesNotMatch(tooltip, /Pinned at/);
});

// ---------------------------------------------------------------------------
// Restore validation
// ---------------------------------------------------------------------------

test("decideRestoredPin keeps an active lease", () => {
  for (const status of ["In-Use", "Waiting", "Unknown"] as LeaseStatus[]) {
    const decision = decideRestoredPin(PIN, {
      kind: "leases",
      leases: [lease({ name: "abc-123", status })],
    });
    assert.deepEqual(decision, { action: "keep" }, `status ${status}`);
  }
});

test("decideRestoredPin clears a missing lease", () => {
  const decision = decideRestoredPin(PIN, { kind: "leases", leases: [lease({ name: "other" })] });
  assert.equal(decision.action, "clear");
  assert.match((decision as { reason: string }).reason, /no longer exists/);
});

test("decideRestoredPin clears an ended or expired lease", () => {
  for (const status of ["Ended", "Expired"] as LeaseStatus[]) {
    const decision = decideRestoredPin(PIN, {
      kind: "leases",
      leases: [lease({ name: "abc-123", status })],
    });
    assert.equal(decision.action, "clear", `status ${status}`);
    assert.match((decision as { reason: string }).reason, new RegExp(status.toLowerCase()));
  }
});

test("decideRestoredPin keeps the pin when auth is blocked", () => {
  assert.deepEqual(decideRestoredPin(PIN, { kind: "auth-blocked", status: "expired" }), {
    action: "keep",
  });
});

test("decideRestoredPin keeps the pin on connection failures", () => {
  assert.deepEqual(
    decideRestoredPin(PIN, {
      kind: "error",
      errorKind: "connection-failed",
      message: "failed to connect to controller",
    }),
    { action: "keep" },
  );
});

test("decideRestoredPin clears when the client config is gone", () => {
  const decision = decideRestoredPin(PIN, {
    kind: "error",
    errorKind: "unknown",
    message: "Failed to load config: client 'lab' does not exist",
  });
  assert.equal(decision.action, "clear");
  assert.match((decision as { reason: string }).reason, /"lab"/);
});

test("decideRestoredPin keeps the pin on other unknown errors", () => {
  assert.deepEqual(
    decideRestoredPin(PIN, { kind: "error", errorKind: "unknown", message: "boom" }),
    { action: "keep" },
  );
});

// ---------------------------------------------------------------------------
// Command-argument coercion
// ---------------------------------------------------------------------------

test("coercePinArgument: string is a lease name", () => {
  assert.deepEqual(coercePinArgument("abc-123"), { leaseName: "abc-123" });
  assert.deepEqual(coercePinArgument(""), {});
});

test("coercePinArgument: undefined and junk yield {}", () => {
  assert.deepEqual(coercePinArgument(undefined), {});
  assert.deepEqual(coercePinArgument(null), {});
  assert.deepEqual(coercePinArgument(42), {});
  assert.deepEqual(coercePinArgument({}), {});
});

test("coercePinArgument: raw Lease uses .name but ignores its .client field", () => {
  const l = lease({ name: "abc-123", client: "controller-side-client" });
  assert.deepEqual(coercePinArgument(l), { leaseName: "abc-123" });
});

test("coercePinArgument: tree node with nested lease and client alias", () => {
  const node = { lease: lease({ name: "abc-123" }), client: "lab" };
  assert.deepEqual(coercePinArgument(node), { leaseName: "abc-123", clientAlias: "lab" });
});

test("coercePinArgument: explicit clientAlias wins over client", () => {
  const node = { leaseName: "abc-123", clientAlias: "lab", client: "other" };
  assert.deepEqual(coercePinArgument(node), { leaseName: "abc-123", clientAlias: "lab" });
});

// ---------------------------------------------------------------------------
// Quick pick entries
// ---------------------------------------------------------------------------

test("isLeasePinnable accepts only In-Use and Waiting", () => {
  assert.equal(isLeasePinnable(lease({ name: "a", status: "In-Use" })), true);
  assert.equal(isLeasePinnable(lease({ name: "a", status: "Waiting" })), true);
  assert.equal(isLeasePinnable(lease({ name: "a", status: "Ended" })), false);
  assert.equal(isLeasePinnable(lease({ name: "a", status: "Expired" })), false);
  assert.equal(isLeasePinnable(lease({ name: "a", status: "Unknown" })), false);
});

test("buildLeasePickEntries filters, sorts pinned-first, and marks picked", () => {
  const leases = [
    lease({ name: "zzz", status: "In-Use" }),
    lease({ name: "aaa", status: "Waiting" }),
    lease({ name: "pinned-1", status: "In-Use" }),
    lease({ name: "dead", status: "Ended" }),
  ];
  const entries = buildLeasePickEntries(leases, "pinned-1");
  assert.deepEqual(
    entries.map((e) => e.leaseName),
    ["pinned-1", "aaa", "zzz"],
  );
  assert.deepEqual(
    entries.map((e) => e.picked),
    [true, false, false],
  );
});

test("buildLeasePickEntries describes status, exporter and remaining time", () => {
  const now = new Date("2026-08-29T10:10:00Z");
  const leases = [
    lease({
      name: "running",
      status: "In-Use",
      exporter: "rpi4-01",
      exporter_name: "rpi4-01",
      duration: 1800,
      effective_begin_time: "2026-08-29T10:00:00Z",
    }),
    // (a lease that waits holds no exporter yet)
    lease({ name: "queued", status: "Waiting", exporter: "", exporter_name: "", selector: "board=rpi4" }),
  ];
  const entries = buildLeasePickEntries(leases, undefined, now);
  const running = entries.find((e) => e.leaseName === "running");
  const queued = entries.find((e) => e.leaseName === "queued");
  assert.equal(running?.description, "In-Use · rpi4-01 · 20m left");
  assert.equal(queued?.description, "Waiting · board=rpi4");
});

// ---------------------------------------------------------------------------
// Remaining-time formatting
// ---------------------------------------------------------------------------

test("formatRemaining covers all buckets", () => {
  assert.equal(formatRemaining(null), "not started");
  assert.equal(formatRemaining(-5), "over-run");
  assert.equal(formatRemaining(0), "over-run");
  assert.equal(formatRemaining(30), "<1m left");
  assert.equal(formatRemaining(5 * 60), "5m left");
  assert.equal(formatRemaining(3665), "1h 1m left");
});

test("a lease with members can be pinned, and is described by its template or its roles", () => {
  const members = lease({
    name: "from-template",
    exporter: "",
    exporter_name: null,
    members: [{ name: "phone" }, { name: "headunit" }],
    template: { template: "ivi" },
  });
  const degraded = lease({
    name: "degraded",
    status: "Degraded",
    exporter: "",
    exporter_name: null,
    members: [{ name: "phone" }, { name: "headunit" }],
    template: null,
  });
  assert.equal(isLeasePinnable(degraded), true);
  const entries = buildLeasePickEntries([members, degraded], undefined, new Date("2026-08-29T10:00:00Z"));
  assert.deepEqual(
    entries.map((entry) => [entry.leaseName, entry.description]),
    [
      ["degraded", "Degraded · phone, headunit · not started"],
      ["from-template", "In-Use · ivi · not started"],
    ],
  );
  assert.equal(coercePinArgument({ kind: "lease", client: "lab", lease: members }).leaseName, "from-template");
});
