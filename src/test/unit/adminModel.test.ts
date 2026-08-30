/**
 * Unit tests for the Administration view logic (src/features/admin/model).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  adminLeaseStatus,
  clientRow,
  describeLabels,
  exporterRow,
  exporterSetRow,
  importedClientNames,
  isLeaseActive,
  leaseRow,
  memberLabels,
  normalizeAdminExporterStatus,
  pickAdminNamespace,
  sortByName,
  sortLeases,
} from "../../features/admin/model";
import { iconForCategory } from "../../features/exporters/model";
import { AdminExporter, AdminLease, ClientConfigList } from "../../types";

const clients: ClientConfigList = {
  currentConfig: "belt",
  items: [
    {
      alias: "belt",
      path: "/home/u/.config/jumpstarter/clients/belt.yaml",
      endpoint: "grpc.example:443",
      metadata: { name: "belt", namespace: "jumpstarter-lab" },
    },
    {
      alias: "other",
      path: "/home/u/.config/jumpstarter/clients/other.yaml",
      endpoint: "grpc.example:443",
      metadata: { name: "other", namespace: "elsewhere" },
    },
  ],
};

test("the configured namespace wins", () => {
  assert.equal(pickAdminNamespace("  chosen  ", clients), "chosen");
});

test("with no setting, the current client's namespace is used", () => {
  assert.equal(pickAdminNamespace("", clients), "jumpstarter-lab");
});

test("with no client at all, fall back to default", () => {
  assert.equal(pickAdminNamespace("", null), "default");
  assert.equal(pickAdminNamespace("", { currentConfig: null, items: [] }), "default");
  // A current alias that names no config must not pick another client's namespace.
  assert.equal(pickAdminNamespace("", { ...clients, currentConfig: "missing" }), "default");
});

test("describeLabels trims a long label set instead of filling the row", () => {
  assert.equal(describeLabels({}), undefined);
  assert.equal(describeLabels({ board: "qemu", arch: "x86" }), "arch=x86 · board=qemu");
  assert.equal(
    describeLabels({ a: "1", b: "2", c: "3", d: "4", e: "5" }),
    "a=1 · b=2 · c=3 +2",
  );
});

test("a client waiting on credentials keeps its icon and changes colour", () => {
  const pending = clientRow({ metadata: { name: "new", namespace: "lab" }, status: null });
  assert.equal(pending.description, "no credential yet");
  assert.deepEqual(pending.icon, { id: "account", colorId: "charts.yellow" });

  const ready = clientRow({
    metadata: { name: "belt", namespace: "lab" },
    status: { endpoint: "grpc.example:443", credential: { name: "belt-client" } },
  });
  assert.equal(ready.description, "grpc.example:443");
  assert.deepEqual(ready.icon, { id: "account", colorId: "charts.blue" });
});

test("an exporter carries the same status icon the Exporters view gives it", () => {
  const base: AdminExporter = {
    metadata: { name: "bench", namespace: "lab", labels: { board: "qemu" } },
    status: { credential: { name: "bench-exporter" }, devices: [] },
  };

  // No status reported at all: the exporter has never checked in.
  const silent = exporterRow(base);
  assert.equal(silent.description, "board=qemu");
  assert.deepEqual(silent.icon, iconForCategory("unknown"));
  assert.match(silent.tooltipMarkdown, /No devices reported/);

  const available = exporterRow({
    ...base,
    status: { ...base.status, exporterStatus: "Available", devices: [{ uuid: "a", labels: {} }] },
  });
  assert.equal(available.description, "board=qemu · 1 device");
  assert.deepEqual(available.icon, iconForCategory("available"));

  const leased = exporterRow({ ...base, status: { ...base.status, exporterStatus: "LeaseReady" } });
  assert.deepEqual(leased.icon, iconForCategory("leased"));

  const offline = exporterRow({ ...base, status: { ...base.status, exporterStatus: "Offline" } });
  assert.deepEqual(offline.icon, iconForCategory("offline"));
});

test("the cluster's PascalCase status maps onto the wire status", () => {
  assert.equal(normalizeAdminExporterStatus("Available"), "AVAILABLE");
  assert.equal(normalizeAdminExporterStatus("LeaseReady"), "LEASE_READY");
  assert.equal(normalizeAdminExporterStatus("BeforeLeaseHookFailed"), "BEFORE_LEASE_HOOK_FAILED");
  assert.equal(normalizeAdminExporterStatus(null), null);
  assert.equal(normalizeAdminExporterStatus(""), null);
  assert.equal(normalizeAdminExporterStatus("SomethingNewer"), null);
});

test("pool members drop the membership labels their pool row already states", () => {
  assert.deepEqual(
    memberLabels({
      board: "qemu",
      "exporterset.jumpstarter.dev/name": "pool",
      "exporterset.jumpstarter.dev/provisioner": "qemu.jumpstarter.dev",
    }),
    { board: "qemu" },
  );
  assert.deepEqual(memberLabels(null), {});
});

const lease = (name: string, over: Partial<AdminLease> = {}): AdminLease => ({
  metadata: { name, namespace: "lab", creationTimestamp: "2026-01-01T00:00:00Z" },
  spec: { client: { name: "belt" }, duration: "1h", selector: { matchLabels: { board: "qemu" } } },
  status: { exporter: { name: "belt-qemu-1" }, beginTime: "2026-01-01T00:00:00Z", ended: false },
  ...over,
});

test("a lease is active until the controller says it ended", () => {
  assert.ok(isLeaseActive(lease("a")));
  assert.ok(!isLeaseActive(lease("b", { status: { ended: true } })));
  // No status at all is a lease the controller has not answered on yet.
  assert.ok(isLeaseActive(lease("c", { status: null })));
});

test("a lease row leads with the exporter it holds", () => {
  const row = leaseRow(lease("01a0"));
  assert.equal(row.label, "belt-qemu-1");
  assert.equal(row.description, "belt · 1h");
  // The same icon the Leases view uses for an in-use lease.
  assert.deepEqual(row.icon, { id: "lock", colorId: "charts.green" });
});

test("an unbound lease falls back to what it is asking for", () => {
  const row = leaseRow(lease("01a0", { status: { ended: false } }));
  assert.equal(row.label, "board=qemu");
  assert.match(row.tooltipMarkdown, /Not bound to an exporter yet/);
  assert.deepEqual(row.icon, { id: "unlock", colorId: "charts.blue" });
});

test("an admin lease is classified the way the Leases view would", () => {
  assert.equal(adminLeaseStatus(lease("a")), "In-Use");
  assert.equal(adminLeaseStatus(lease("b", { status: { ended: false } })), "Waiting");
  assert.equal(adminLeaseStatus(lease("c", { status: { ended: true } })), "Ended");
  assert.deepEqual(leaseRow(lease("d", { status: { ended: true } })).icon, {
    id: "unlock",
    colorId: "disabledForeground",
  });
});

test("leases sort active first, then newest", () => {
  const sorted = sortLeases([
    lease("old", { status: { ended: true, beginTime: "2026-01-01T00:00:00Z" } }),
    lease("older-active", { status: { ended: false, beginTime: "2026-01-02T00:00:00Z" } }),
    lease("newest-active", { status: { ended: false, beginTime: "2026-01-03T00:00:00Z" } }),
  ]);
  assert.deepEqual(
    sorted.map((l) => l.metadata.name),
    ["newest-active", "older-active", "old"],
  );
});

test("an exporter set row shows how much of the pool is free", () => {
  const row = exporterSetRow({
    metadata: { name: "pool", namespace: "lab" },
    spec: { virtualTargetClassName: "qemu", provisioner: "qemu.jumpstarter.dev", maxReplicas: 4 },
    status: { replicas: 3, availableReplicas: 1, readyReplicas: 3, leasedReplicas: 2 },
    exporters: [],
  });
  assert.equal(row.description, "1/3 available");
  assert.match(row.tooltipMarkdown, /Provisioner: `qemu\.jumpstarter\.dev`/);
});

test("sortByName orders rows the way the tree shows them", () => {
  const sorted = sortByName([
    { metadata: { name: "b", namespace: "lab" } },
    { metadata: { name: "a", namespace: "lab" } },
  ]);
  assert.deepEqual(
    sorted.map((item) => item.metadata.name),
    ["a", "b"],
  );
});

test("importedClientNames matches cluster clients by the name they were issued as", () => {
  const names = importedClientNames(clients);
  assert.ok(names.has("belt"));
  assert.ok(names.has("other"));
  assert.ok(!names.has("belt.yaml"));
  assert.equal(importedClientNames(null).size, 0);
});
