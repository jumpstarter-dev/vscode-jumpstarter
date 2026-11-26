/** A request for a lease is shown until the lease is held, has ended, or the time allowed is over. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  describeReleasing,
  isReleased,
  leasesStillPending,
  leaseWaitStep,
  ListedLease,
  waitForLease,
  waitForRelease,
} from "../../services/pendingLeasesModel";

/** A wait over the given readings of the listing (the last one repeats), on a clock that only sleeping moves. */
function waitOver(readings: (readonly ListedLease[] | Error)[], timeoutMs = 60_000) {
  let clock = 0;
  let asked = 0;
  const outcome = waitForLease("lease-1", {
    list: async () => {
      const reading = readings[Math.min(asked++, readings.length - 1)];
      if (reading instanceof Error) {
        throw reading;
      }
      return reading;
    },
    timeoutMs,
    intervalMs: 2_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return outcome.then((value) => ({ outcome: value, asked, waited: clock }));
}

test("a lease that is made, waits, and is then held: the wait ends when it is held", async () => {
  const result = await waitOver([
    [], // made, and not in the listing yet
    [{ name: "lease-1", status: "Waiting" }],
    [{ name: "lease-1", status: "Waiting" }],
    [{ name: "lease-1", status: "In-Use" }],
  ]);
  assert.deepEqual(result, { outcome: "acquired", asked: 4, waited: 6_000 });
});

test("a lease that is held at once is not waited for", async () => {
  assert.deepEqual(await waitOver([[{ name: "lease-1", status: "In-Use" }]]), {
    outcome: "acquired",
    asked: 1,
    waited: 0,
  });
  // a lease with members whose optional role has no exporter is held too
  assert.equal((await waitOver([[{ name: "lease-1", status: "Degraded" }]])).outcome, "acquired");
});

test("a lease that ends before it is held ends the wait, and so does one that was listed and is gone", async () => {
  assert.equal((await waitOver([[{ name: "lease-1", status: "Waiting" }], [{ name: "lease-1", status: "Ended" }]])).outcome, "ended");
  assert.equal((await waitOver([[{ name: "lease-1", status: "Expired" }]])).outcome, "ended");
  assert.equal((await waitOver([[{ name: "lease-1", status: "Waiting" }], [{ name: "other", status: "In-Use" }]])).outcome, "ended");
});

test("a lease that is never held is given up when the time allowed is over, not before", async () => {
  const waiting = await waitOver([[{ name: "lease-1", status: "Waiting" }]], 10_000);
  assert.equal(waiting.outcome, "timeout");
  assert.equal(waiting.waited, 10_000);
  // one that never comes into the listing is not taken for gone
  assert.equal((await waitOver([[]], 10_000)).outcome, "timeout");
});

test("a listing that fails says nothing of the lease: the next one is asked", async () => {
  const result = await waitOver([new Error("unavailable"), new Error("unavailable"), [{ name: "lease-1", status: "In-Use" }]]);
  assert.equal(result.outcome, "acquired");
  assert.equal(result.asked, 3);
});

test("one reading of the listing: nothing to say of a lease that is not listed yet or still waits", () => {
  assert.deepEqual(leaseWaitStep("lease-1", [], false), { seen: false });
  assert.deepEqual(leaseWaitStep("lease-1", [{ name: "lease-1", status: "Waiting" }], false), { seen: true });
  assert.deepEqual(leaseWaitStep("lease-1", [{ name: "lease-1", status: "Unknown" }], true), { seen: true });
});

test("a listing leaves out the leases whose request is still shown, for the client that asked", () => {
  const entries = [
    { id: "pending-1", client: "lab", label: "cf-phone", startedAt: 0, leaseName: "lease-1" },
    { id: "pending-2", client: "lab", label: "cf-headunit", startedAt: 0 }, // not made yet
    { id: "pending-3", client: "other", label: "ipad", startedAt: 0, leaseName: "lease-3" },
  ];
  assert.deepEqual([...leasesStillPending(entries, "lab")], ["lease-1"]);
  assert.deepEqual([...leasesStillPending(entries, "other")], ["lease-3"]);
  assert.deepEqual([...leasesStillPending([], "lab")], []);
});

/** A wait for the end of a lease over the given readings (the last one repeats), on a clock that only sleeping moves. */
function releaseOver(readings: (readonly ListedLease[] | Error)[], timeoutMs = 60_000) {
  let clock = 0;
  let asked = 0;
  return waitForRelease("lease-1", {
    list: async () => {
      const reading = readings[Math.min(asked++, readings.length - 1)];
      if (reading instanceof Error) {
        throw reading;
      }
      return reading;
    },
    timeoutMs,
    intervalMs: 2_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  }).then((outcome) => ({ outcome, asked, waited: clock }));
}

test("a lease that was ended is waited for until a listing no longer has it", async () => {
  const held: ListedLease[] = [{ name: "lease-1", status: "In-Use" }];
  assert.deepEqual(await releaseOver([held, held, [{ name: "other", status: "In-Use" }]]), {
    outcome: "released",
    asked: 3,
    waited: 4_000,
  });
  // gone at once, and listed as ended (the history is shown): both are released
  assert.deepEqual(await releaseOver([[]]), { outcome: "released", asked: 1, waited: 0 });
  assert.equal((await releaseOver([held, [{ name: "lease-1", status: "Ended" }]])).outcome, "released");
});

test("a lease that stays held is given up when the time allowed is over, and a failed listing is asked again", async () => {
  const held: ListedLease[] = [{ name: "lease-1", status: "In-Use" }];
  const stuck = await releaseOver([held], 10_000);
  assert.deepEqual({ outcome: stuck.outcome, waited: stuck.waited }, { outcome: "timeout", waited: 10_000 });
  // a listing that failed does not say the lease is gone
  assert.equal((await releaseOver([new Error("unavailable"), held, []])).asked, 3);
  assert.equal(isReleased("lease-1", [{ name: "lease-1", status: "Waiting" }]), false);
  assert.equal(isReleased("lease-1", [{ name: "lease-1", status: "Expired" }]), true);
});

test("a lease on its way out says for how long", () => {
  assert.equal(describeReleasing(1_000, 1_200), "releasing…");
  assert.equal(describeReleasing(1_000, 4_000), "releasing… 3s");
  assert.equal(describeReleasing(1_000, 0), "releasing…");
});
