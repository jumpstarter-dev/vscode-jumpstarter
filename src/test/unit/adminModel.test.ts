/**
 * Unit tests for the Administration view logic (src/features/admin/model).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  clientRow,
  describeLabels,
  exporterRow,
  exporterSetRow,
  importedClientNames,
  isLeaseActive,
  leaseRow,
  pickAdminNamespace,
  sortByName,
  sortLeases,
} from "../../features/admin/model";
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

test("a client without credentials is called out rather than shown as ready", () => {
  const pending = clientRow({ metadata: { name: "new", namespace: "lab" }, status: null });
  assert.equal(pending.description, "no credential yet");
  assert.equal(pending.icon.id, "circle-outline");

  const ready = clientRow({
    metadata: { name: "belt", namespace: "lab" },
    status: { endpoint: "grpc.example:443", credential: { name: "belt-client" } },
  });
  assert.equal(ready.description, "grpc.example:443");
  assert.equal(ready.icon.id, "account");
});

test("an exporter with no devices reads as registered but not running", () => {
  const idle: AdminExporter = {
    metadata: { name: "bench", namespace: "lab", labels: { board: "qemu" } },
    status: { credential: { name: "bench-exporter" }, devices: [] },
  };
  const row = exporterRow(idle);
  assert.equal(row.description, "board=qemu");
  assert.equal(row.icon.id, "vm-outline");
  assert.match(row.tooltipMarkdown, /No devices reported/);

  const running = exporterRow({
    ...idle,
    status: { ...idle.status, devices: [{ uuid: "a", labels: {} }] },
  });
  assert.equal(running.description, "board=qemu · 1 device");
  assert.equal(running.icon.id, "vm-active");
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
  assert.equal(row.icon.id, "circle-filled");
});

test("an unbound lease falls back to what it is asking for", () => {
  const row = leaseRow(lease("01a0", { status: { ended: false } }));
  assert.equal(row.label, "board=qemu");
  assert.match(row.tooltipMarkdown, /Not bound to an exporter yet/);
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
