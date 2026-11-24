/**
 * Unit tests for the details pane renderer (src/features/details/render).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildExporterSections,
  buildLeaseSections,
  escapeHtml,
  renderDetailsHtml,
  selectionTitle,
} from "../../features/details/render";
import { Exporter, Lease } from "../../types";
import { ClientRow } from "../../features/clients/logic";

function makeExporter(overrides: Partial<Exporter> = {}): Exporter {
  return {
    namespace: "lab",
    name: "rpi4-01",
    labels: { board: "rpi4" },
    deprecated_labels: {},
    online: true,
    status: "AVAILABLE",
    enabled: true,
    lease: null,
    ...overrides,
  };
}

function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    name: "lease-abc",
    namespace: "lab",
    selector: "board=rpi4",
    exporter: "lab/rpi4-01",
    exporter_name: "rpi4-01",
    client: "alice",
    duration: 5400,
    effective_begin_time: null,
    effective_end_time: null,
    begin_time: null,
    tags: { build: "1234" },
    context: {},
    conditions: [],
    status: "In-Use",
    ...overrides,
  };
}

function makeClient(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    alias: "belt",
    isCurrent: true,
    endpoint: "grpc.example.com:443",
    path: "/home/u/.config/jumpstarter/clients/belt.yaml",
    namespace: "jumpstarter-lab",
    name: "belt",
    auth: undefined,
    authError: undefined,
    ...overrides,
  };
}

function findRow(sections: ReturnType<typeof buildExporterSections>, label: string) {
  for (const section of sections) {
    const row = section.rows.find((r) => r.label === label);
    if (row) {
      return row;
    }
  }
  return undefined;
}

test("escapeHtml: neutralizes markup", () => {
  assert.equal(escapeHtml('<img src=x onerror="y">'), "&lt;img src=x onerror=&quot;y&quot;&gt;");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

test("renderDetailsHtml: placeholder when nothing is selected", () => {
  const html = renderDetailsHtml(null);
  assert.match(html, /Select a client, exporter, lease or lease template/);
  assert.match(html, /Content-Security-Policy/);
});

test("renderDetailsHtml: escapes values from the cluster", () => {
  const html = renderDetailsHtml({
    kind: "exporter",
    exporter: makeExporter({ name: "<script>alert(1)</script>" }),
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("exporter sections: absent enabled reads as yes, null status as em dash", () => {
  const sections = buildExporterSections(makeExporter({ enabled: undefined, status: null }));
  assert.equal(findRow(sections, "Enabled")?.value, "yes");
  assert.equal(findRow(sections, "Status")?.value, "—");
});

test("exporter sections: lease section only when held", () => {
  assert.equal(
    buildExporterSections(makeExporter()).some((s) => s.title === "Current lease"),
    false,
  );
  const held = buildExporterSections(makeExporter({ lease: makeLease() }));
  assert.equal(held.some((s) => s.title === "Current lease"), true);
});

test("lease sections: duration renders compactly and tags are formatted", () => {
  const sections = buildLeaseSections(makeLease());
  assert.equal(findRow(sections, "Duration")?.value, "1h30m");
  assert.equal(findRow(sections, "Tags")?.value, "build=1234");
  assert.equal(findRow(sections, "Ended")?.value, "—");
});

test("client sections: auth error takes the status slot", () => {
  const html = renderDetailsHtml({
    kind: "client",
    client: makeClient({ authError: "auth unknown" }),
  });
  assert.match(html, /auth unknown/);
});

test("selectionTitle: names the selected resource", () => {
  assert.equal(selectionTitle({ kind: "exporter", exporter: makeExporter() }), "rpi4-01");
  assert.equal(selectionTitle({ kind: "lease", lease: makeLease() }), "lease-abc");
  assert.equal(selectionTitle({ kind: "client", client: makeClient() }), "belt");
});

test("lease sections: a lease with members has its template, roles and forwards, and no exporter row", () => {
  const sections = buildLeaseSections({
    name: "lease-9m2qd",
    namespace: "default",
    selector: "",
    exporter: "",
    exporter_name: null,
    client: "ci-runner",
    duration: 2700,
    effective_begin_time: null,
    effective_end_time: null,
    begin_time: null,
    tags: {},
    context: {},
    conditions: [],
    status: "Degraded",
    members: [{ name: "phone", optional: true }, { name: "headunit" }],
    member_statuses: [
      { name: "phone", state: "Lost", exporter: "rack3-phone-4", reason: "ExporterOffline", message: "went offline" },
      { name: "headunit", state: "Bound", exporter: "rack3-hu-2" },
    ],
    template: { template: "ivi" },
    forwards: [
      {
        name: "bt",
        endpoints: [
          { member_name: "headunit", port_name: "rootcanal" },
          { member_name: "phone", port_name: "controller" },
        ],
      },
    ],
    forward_statuses: [{ name: "bt", state: "Failed", message: "member phone is lost" }],
  });
  assert.deepEqual(sections.map((section) => section.title), ["Lease", "Roles", "Forwards", "Timing", "Metadata"]);
  assert.deepEqual(sections[0].rows.map((row) => row.label), ["Name", "Namespace", "Status", "Client", "Template"]);
  assert.equal(sections[0].rows[4].value, "ivi");
  assert.deepEqual(sections[1].rows.map((row) => `${row.label}: ${row.value}`), [
    "phone*: rack3-phone-4 · Lost: ExporterOffline · went offline",
    "headunit: rack3-hu-2 · Bound",
  ]);
  assert.deepEqual(sections[2].rows.map((row) => `${row.label}: ${row.value}`), [
    "bt: headunit.rootcanal, phone.controller · Failed · member phone is lost",
  ]);
});
