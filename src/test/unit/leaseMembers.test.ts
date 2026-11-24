/**
 * Unit tests for a lease with members in the Leases view: its roles, its
 * forwards and its row (src/features/leases/members.ts and model.ts), against
 * the output of the real CLI (src/test/fixtures/cli). Plain node:test.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildForwardRow,
  buildRoleRow,
  describeDegraded,
  describeForward,
  isDegraded,
  isMemberLease,
  leaseForwards,
  leaseRoles,
  leaseTarget,
  portDirections,
} from "../../features/leases/members";
import {
  buildCommandArgs,
  buildDriverNodes,
  buildLeaseRow,
  describeLeaseHolding,
  isActiveStatus,
  sortLeases,
} from "../../features/leases/model";
import { parseExporterPorts, parseLeases, parseRoleDrivers } from "../../services/leaseProtocol";
import { Lease, isLeaseUsable } from "../../types";
import { fixtureJson, fixtureText } from "./cliFixtures";

const leases = parseLeases(fixtureJson("leases.json"));
const byName = (name: string): Lease => {
  const lease = leases.find((candidate) => candidate.name === name);
  assert.ok(lease, `no lease ${name} in the fixture`);
  return lease;
};
const ports = parseExporterPorts(fixtureJson("exporters-ports.json"));

/** Nothing a row shows may be the text of a missing value. */
function assertNoMissingValues(text: string): void {
  assert.doesNotMatch(text, /undefined|null|NaN|\[object/);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

test("isMemberLease: by the roles, not by the missing exporter", () => {
  assert.equal(isMemberLease(byName("lease-9m2qd")), true);
  assert.equal(isMemberLease(byName("lease-scalar")), false);
  assert.equal(isMemberLease({ members: [] }), false);
  assert.equal(isMemberLease({}), false);
});

test("leaseRoles: each role with its exporter and state, in the lease's order", () => {
  assert.deepEqual(
    leaseRoles(byName("lease-9m2qd")).map((role) => [role.name, role.optional, role.state, role.exporter, role.bound]),
    [
      ["phone", true, "Bound", "rack3-phone-4", true],
      ["headunit", false, "Bound", "rack3-hu-2", true],
    ],
  );
  const [lost] = leaseRoles(byName("lease-degraded"));
  assert.deepEqual([lost.state, lost.exporter, lost.reason, lost.bound], ["Lost", "rack3-phone-4", "ExporterOffline", false]);
  const [omitted] = leaseRoles(byName("lease-omitted"));
  assert.deepEqual([omitted.state, omitted.exporter, omitted.reason, omitted.bound], ["Omitted", null, "Excluded", false]);
  // A lease the controller has not bound yet reports no role: each is Pending.
  assert.deepEqual(
    leaseRoles(byName("lease-pending")).map((role) => [role.state, role.bound]),
    [["Pending", false], ["Pending", false]],
  );
  assert.deepEqual(leaseRoles(byName("lease-scalar")), []);
});

test("a role's row: exporter and state, the reason of a role that is not there", () => {
  const lease = byName("lease-9m2qd");
  const [phone, headunit] = leaseRoles(lease);
  const row = buildRoleRow(lease, phone, true);
  assert.equal(row.label, "phone");
  assert.equal(row.description, "rack3-phone-4 · Bound · optional");
  assert.equal(row.contextValue, "jumpstarterRole-bound");
  assert.equal(row.expandable, true);
  assert.equal(row.icon, "server-environment");
  assert.match(row.tooltip, /Commands run as: j phone DRIVER/);
  assert.equal(buildRoleRow(lease, headunit, true).description, "rack3-hu-2 · Bound");
  // (a role of a lease that cannot be worked on has no drivers to open)
  assert.equal(buildRoleRow(lease, headunit, false).expandable, false);

  const degraded = byName("lease-degraded");
  const lost = buildRoleRow(degraded, leaseRoles(degraded)[0], true);
  assert.equal(lost.description, "Lost: ExporterOffline · was rack3-phone-4 · optional");
  assert.equal(lost.contextValue, "jumpstarterRole-lost");
  assert.equal(lost.expandable, false);
  assert.deepEqual([lost.icon, lost.iconColor], ["error", "charts.red"]);
  assert.match(lost.tooltip, /the exporter went offline/);

  const left = byName("lease-omitted");
  const omitted = buildRoleRow(left, leaseRoles(left)[0], true);
  assert.equal(omitted.description, "Omitted: Excluded · optional");
  assert.equal(omitted.contextValue, "jumpstarterRole-omitted");
  assert.equal(omitted.expandable, false);

  const waiting = byName("lease-pending");
  const pending = buildRoleRow(waiting, leaseRoles(waiting)[1], false);
  assert.equal(pending.description, "Pending");
  assert.equal(pending.contextValue, "jumpstarterRole-pending");
});

test("a state the controller adds later is shown as it is named", () => {
  const lease = parseLeases({
    leases: [{ name: "l", members: [{ name: "phone" }], member_statuses: [{ name: "phone", state: "Migrating" }] }],
  })[0];
  const row = buildRoleRow(lease, leaseRoles(lease)[0], true);
  assert.equal(row.description, "Migrating");
  assert.equal(row.contextValue, "jumpstarterRole-unknown");
  assert.equal(row.icon, "question");
});

test("isDegraded: a lost role, while the lease runs", () => {
  assert.equal(isDegraded(byName("lease-degraded")), true);
  assert.equal(describeDegraded(byName("lease-degraded")), "Degraded: phone (ExporterOffline) lost its exporter");
  assert.equal(isDegraded(byName("lease-9m2qd")), false);
  assert.equal(isDegraded(byName("lease-omitted")), false); // left out on purpose
  assert.equal(isDegraded(byName("lease-scalar")), false);
  // A CLI that derives the status another way still has the lost role to go by; an ended lease is just ended.
  assert.equal(isDegraded({ ...byName("lease-degraded"), status: "In-Use" }), true);
  assert.equal(isDegraded({ ...byName("lease-degraded"), status: "Ended" }), false);
});

// ---------------------------------------------------------------------------
// Forwards
// ---------------------------------------------------------------------------

test("describeForward: an arrow from the port that provides, as the CLI draws it", () => {
  const lease = byName("lease-9m2qd");
  const [forward] = lease.forwards ?? [];
  assert.equal(describeForward(forward, portDirections(lease, ports)), "headunit.rootcanal → phone.controller");
  // Without the ports (an older CLI, an exporter that is gone) the endpoints are in the lease's order.
  assert.equal(describeForward(forward), "headunit.rootcanal, phone.controller");
  assert.equal(describeForward(forward, portDirections(lease, {})), "headunit.rootcanal, phone.controller");
});

test("describeForward: requires first, many targets, and the two ends of a path", () => {
  const known: Record<string, string> = {
    "a.out": "provides",
    "b.in": "requires",
    "c.in": "requires",
    "x.can": "connects",
    "y.can": "connects",
  };
  const direction = (role: string, port: string): string | undefined => known[`${role}.${port}`];
  const forward = (...endpoints: string[]) => ({
    name: "f",
    endpoints: endpoints.map((endpoint) => {
      const [member_name, port_name] = endpoint.split(".");
      return { member_name, port_name };
    }),
  });
  assert.equal(describeForward(forward("b.in", "a.out", "c.in"), direction), "a.out → b.in, c.in");
  assert.equal(describeForward(forward("x.can", "y.can"), direction), "x.can ↔ y.can");
  // Two that provide, or one that is not known: no arrow is claimed.
  assert.equal(describeForward(forward("a.out", "a.out"), direction), "a.out, a.out");
  assert.equal(describeForward(forward("a.out", "z.in"), direction), "a.out, z.in");
  assert.equal(describeForward({ name: "empty", endpoints: [] }, direction), "");
});

test("leaseForwards: the state of each forward, Pending until the controller reports it", () => {
  const connected = leaseForwards(byName("lease-9m2qd"), portDirections(byName("lease-9m2qd"), ports));
  assert.deepEqual(connected, [
    {
      name: "bt",
      endpoints: "headunit.rootcanal → phone.controller",
      state: "Connected",
      message: null,
      ends: ["headunit: Connected", "phone: Connected"],
    },
  ]);
  const unreported = leaseForwards({ forwards: byName("lease-9m2qd").forwards, forward_statuses: [] });
  assert.deepEqual([unreported[0].state, unreported[0].ends], ["Pending", []]);
  assert.deepEqual(leaseForwards(byName("lease-scalar")), []);
});

test("a forward's row: endpoints, state and the cause of one that does not operate; the ends in the tooltip", () => {
  const lease = byName("lease-9m2qd");
  const row = buildForwardRow(lease, leaseForwards(lease, portDirections(lease, ports))[0]);
  assert.equal(row.label, "bt");
  assert.equal(row.description, "headunit.rootcanal → phone.controller · Connected");
  assert.deepEqual([row.icon, row.iconColor], ["plug", "charts.green"]);
  assert.match(row.tooltip, /Ends:\n {2}headunit: Connected\n {2}phone: Connected/);

  const degraded = byName("lease-degraded");
  const failed = buildForwardRow(degraded, leaseForwards(degraded)[0]);
  assert.equal(failed.description, "headunit.rootcanal, phone.controller · Failed: member phone is lost");
  assert.deepEqual([failed.icon, failed.iconColor], ["error", "charts.red"]);
  assert.match(failed.tooltip, /phone: Failed \(the exporter went offline\)/);

  const left = byName("lease-omitted");
  const disabled = buildForwardRow(left, leaseForwards(left)[0]);
  assert.equal(disabled.description, "headunit.rootcanal, phone.controller · Disabled: the member phone is left out");
  assert.equal(disabled.icon, "circle-slash");
});

// ---------------------------------------------------------------------------
// The lease's own row
// ---------------------------------------------------------------------------

test("a lease with members is named by its template, else by its roles", () => {
  assert.equal(leaseTarget(byName("lease-9m2qd")), "ivi");
  assert.equal(leaseTarget(byName("lease-degraded")), "phone, headunit");
  assert.equal(leaseTarget(byName("lease-scalar")), "");
  assert.equal(describeLeaseHolding(byName("lease-9m2qd")), " from template 'ivi' (roles phone, headunit)");
  assert.equal(describeLeaseHolding(byName("lease-degraded")), " with roles phone, headunit");
  assert.equal(describeLeaseHolding(byName("lease-scalar")), "");
});

test("buildLeaseRow: a lease with members shows its template, expands, and takes every action of a lease in use", () => {
  const row = buildLeaseRow(byName("lease-9m2qd"), new Date(), portDirections(byName("lease-9m2qd"), ports));
  assert.equal(row.description, "ivi · In-Use");
  assert.equal(row.contextValue, "jumpstarterLease-inUse-members");
  assert.equal(row.expandable, true);
  assert.match(row.tooltip, /Template: ivi/);
  assert.match(row.tooltip, /phone\*: rack3-phone-4 \[Bound\]/);
  assert.match(row.tooltip, /bt: headunit\.rootcanal → phone\.controller \[Connected\]/);
  assert.doesNotMatch(row.tooltip, /Exporter:/);
});

test("buildLeaseRow: a degraded lease says so and is still a lease in use", () => {
  const row = buildLeaseRow(byName("lease-degraded"));
  assert.equal(row.description, "phone, headunit · Degraded");
  assert.match(row.contextValue, /^jumpstarterLease-inUse/);
  assert.deepEqual([row.icon, row.iconColor], ["lock", "list.warningForeground"]);
  assert.equal(row.expandable, true);
  assert.equal(isLeaseUsable("Degraded"), true);
  assert.equal(isActiveStatus("Degraded"), true);
});

test("buildLeaseRow: a lease with members that is still waiting opens into its pending roles", () => {
  const row = buildLeaseRow(byName("lease-pending"));
  assert.equal(row.description, "phone, headunit · Waiting");
  assert.match(row.contextValue, /^jumpstarterLease-waiting/);
  assert.equal(row.expandable, true);
});

test("no row of any lease of the listing shows a missing value", () => {
  for (const lease of leases) {
    const row = buildLeaseRow(lease, new Date(), portDirections(lease, ports));
    assertNoMissingValues(`${row.label}|${row.description}|${row.tooltip}|${row.contextValue}`);
    for (const role of leaseRoles(lease)) {
      const roleRow = buildRoleRow(lease, role, true);
      assertNoMissingValues(`${roleRow.label}|${roleRow.description}|${roleRow.tooltip}`);
    }
    for (const forward of leaseForwards(lease)) {
      const forwardRow = buildForwardRow(lease, forward);
      assertNoMissingValues(`${forwardRow.label}|${forwardRow.description}|${forwardRow.tooltip}`);
    }
  }
});

test("buildLeaseRow: a lease of one exporter is as it was", () => {
  const row = buildLeaseRow({
    name: "lease-1",
    namespace: "lab",
    selector: "board=rpi4",
    exporter: "lab/bench-1",
    exporter_name: "bench-1",
    client: "fake",
    duration: 3600,
    effective_begin_time: null,
    effective_end_time: null,
    begin_time: null,
    tags: {},
    context: {},
    conditions: [],
    status: "In-Use",
  });
  assert.equal(row.description, "bench-1 · In-Use");
  assert.equal(row.contextValue, "jumpstarterLease-inUse");
  assert.equal(row.tooltip, "lease-1\nExporter: bench-1\nStatus: In-Use\nDuration: 1h 0m");
  assert.deepEqual([row.icon, row.iconColor], ["lock", "charts.green"]);
});

test("sortLeases: a degraded lease is with the leases in use", () => {
  assert.deepEqual(
    sortLeases(leases).map((lease) => lease.name),
    ["lease-9m2qd", "lease-degraded", "lease-omitted", "lease-scalar", "lease-pending"],
  );
});

// ---------------------------------------------------------------------------
// The drivers of a role
// ---------------------------------------------------------------------------

test("buildDriverNodes: a role's drivers are a lease's drivers, with commands that name the role", () => {
  const roles = parseRoleDrivers(fixtureText("role-drivers.txt"));
  assert.ok("driver_tree" in roles.phone);
  const drivers = buildDriverNodes(roles.phone.driver_tree, "phone");
  // (the root composite is the session itself, not a driver)
  assert.deepEqual(drivers.map((driver) => [driver.label, driver.description, driver.role]), [
    ["power", "PowerClient", "phone"],
  ]);
  assert.deepEqual(drivers[0].driverPath, ["power"]);
  assert.deepEqual(
    drivers[0].commands.map((command) => command.label),
    ["j phone power cycle", "j phone power off", "j phone power on", "j phone power read", "j phone power status"],
  );
  const on = drivers[0].commands.find((command) => command.cliPath.join(" ") === "power on");
  assert.ok(on);
  assert.deepEqual(buildCommandArgs(on, new Map()), ["phone", "power", "on"]);

  // The same tree without a role is a lease of one exporter's: `j power on`.
  const scalar = buildDriverNodes(roles.phone.driver_tree);
  assert.equal(scalar[0].role, undefined);
  assert.equal(scalar[0].commands[2].label, "j power on");
  assert.deepEqual(buildCommandArgs(scalar[0].commands[2], new Map()), ["power", "on"]);
});
