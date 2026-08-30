/**
 * Unit tests for the pure Exporters-view logic (src/features/exporters/model).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildExporterItemSpec,
  buildExporterTooltipMarkdown,
  buildSelector,
  categorizeExporter,
  collectLabelKeys,
  collectLabelValues,
  effectiveLabels,
  exporterMatchesSelector,
  filterExportersBySelector,
  formatDurationShort,
  formatLabels,
  iconForCategory,
  isValidDuration,
  parseSelector,
  sortExporters,
} from "../../features/exporters/model";
import { Exporter, Lease } from "../../types";

function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    name: "lease-abc",
    namespace: "lab",
    selector: "",
    exporter: "lab/rpi4-01",
    exporter_name: "rpi4-01",
    client: "alice",
    duration: 1800,
    effective_begin_time: null,
    effective_end_time: null,
    begin_time: null,
    tags: {},
    context: {},
    conditions: [],
    status: "In-Use",
    ...overrides,
  };
}

function makeExporter(overrides: Partial<Exporter> = {}): Exporter {
  return {
    namespace: "lab",
    name: "rpi4-01",
    labels: { board: "rpi4", site: "lab1" },
    deprecated_labels: {},
    online: true,
    status: "AVAILABLE",
    enabled: true,
    lease: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Status categorization + icons
// ---------------------------------------------------------------------------

test("categorizeExporter: buckets every status", () => {
  assert.equal(categorizeExporter("AVAILABLE", true), "available");
  assert.equal(categorizeExporter("LEASE_READY", true), "leased");
  assert.equal(categorizeExporter("BEFORE_LEASE_HOOK", true), "leased");
  assert.equal(categorizeExporter("AFTER_LEASE_HOOK", true), "leased");
  assert.equal(categorizeExporter("BEFORE_LEASE_HOOK_FAILED", true), "failed");
  assert.equal(categorizeExporter("AFTER_LEASE_HOOK_FAILED", true), "failed");
  assert.equal(categorizeExporter("OFFLINE", false), "offline");
  assert.equal(categorizeExporter("UNSPECIFIED", true), "unknown");
});

test("categorizeExporter: offline overrides AVAILABLE and UNSPECIFIED", () => {
  assert.equal(categorizeExporter("AVAILABLE", false), "offline");
  assert.equal(categorizeExporter("UNSPECIFIED", false), "offline");
});

test("iconForCategory: colors match the spec", () => {
  assert.deepEqual(iconForCategory("available"), {
    id: "pass",
    colorId: "charts.green",
  });
  assert.deepEqual(iconForCategory("leased"), {
    id: "pass-filled",
    colorId: "charts.green",
  });
  assert.deepEqual(iconForCategory("failed"), {
    id: "error",
    colorId: "charts.red",
  });
  assert.deepEqual(iconForCategory("offline"), {
    id: "circle-slash",
    colorId: "charts.red",
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test("effectiveLabels: current labels win over deprecated", () => {
  const e = makeExporter({
    labels: { board: "rpi4" },
    deprecated_labels: { board: "old", site: "lab9" },
  });
  assert.deepEqual(effectiveLabels(e), { board: "rpi4", site: "lab9" });
});

test("formatLabels: sorted k=v list", () => {
  assert.equal(formatLabels({ site: "lab1", board: "rpi4" }), "board=rpi4, site=lab1");
  assert.equal(formatLabels({}), "");
});

test("collectLabelKeys/Values: sorted unique across exporters", () => {
  const exporters = [
    makeExporter({ labels: { board: "rpi4", site: "lab1" } }),
    makeExporter({ name: "x2", labels: { board: "orin", rack: "r1" } }),
  ];
  assert.deepEqual(collectLabelKeys(exporters), ["board", "rack", "site"]);
  assert.deepEqual(collectLabelValues(exporters, "board"), ["orin", "rpi4"]);
  assert.deepEqual(collectLabelValues(exporters, "nope"), []);
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

test("parseSelector: valid, empty and invalid inputs", () => {
  assert.deepEqual(parseSelector("board=rpi4"), [{ key: "board", value: "rpi4" }]);
  assert.deepEqual(parseSelector(" board=rpi4 , site=lab1 "), [
    { key: "board", value: "rpi4" },
    { key: "site", value: "lab1" },
  ]);
  assert.deepEqual(parseSelector(""), []);
  assert.deepEqual(parseSelector("   "), []);
  assert.equal(parseSelector("board"), null);
  assert.equal(parseSelector("board="), null);
  assert.equal(parseSelector("=rpi4"), null);
  assert.equal(parseSelector("a=b=c"), null);
  assert.equal(parseSelector("a=b,,"), null);
});

test("buildSelector: round-trips parseSelector", () => {
  const raw = "board=rpi4,site=lab1";
  const pairs = parseSelector(raw);
  assert.ok(pairs);
  assert.equal(buildSelector(pairs), raw);
});

test("exporterMatchesSelector: all pairs must match effective labels", () => {
  const e = makeExporter({
    labels: { board: "rpi4" },
    deprecated_labels: { site: "lab1" },
  });
  assert.equal(exporterMatchesSelector(e, [{ key: "board", value: "rpi4" }]), true);
  assert.equal(exporterMatchesSelector(e, [{ key: "site", value: "lab1" }]), true);
  assert.equal(
    exporterMatchesSelector(e, [
      { key: "board", value: "rpi4" },
      { key: "site", value: "lab2" },
    ]),
    false,
  );
  assert.equal(exporterMatchesSelector(e, []), true);
});

test("filterExportersBySelector: empty selector matches everything", () => {
  const exporters = [
    makeExporter(),
    makeExporter({ name: "orin-01", labels: { board: "orin" } }),
  ];
  assert.equal(filterExportersBySelector(exporters, []).length, 2);
  const filtered = filterExportersBySelector(exporters, [{ key: "board", value: "orin" }]);
  assert.deepEqual(
    filtered.map((e) => e.name),
    ["orin-01"],
  );
});

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

test("isValidDuration: accepts CLI-style strings", () => {
  for (const good of ["15m", "30m", "1h", "4h", "8h", "1h30m", "2d4h", "45s", "1d2h3m4s"]) {
    assert.equal(isValidDuration(good), true, good);
  }
  for (const bad of ["", "  ", "h", "30", "m30", "1h30", "30m1h", "-30m", "1.5h", "30 m"]) {
    assert.equal(isValidDuration(bad), false, bad);
  }
});

test("formatDurationShort: compact d/h/m/s", () => {
  assert.equal(formatDurationShort(5400), "1h30m");
  assert.equal(formatDurationShort(3600), "1h");
  assert.equal(formatDurationShort(90061), "1d1h1m");
  assert.equal(formatDurationShort(45), "45s");
  assert.equal(formatDurationShort(-10), "0s");
});

// ---------------------------------------------------------------------------
// Tree item specs
// ---------------------------------------------------------------------------

test("buildExporterItemSpec: available exporter", () => {
  const spec = buildExporterItemSpec(makeExporter());
  assert.equal(spec.id, "lab/rpi4-01");
  assert.equal(spec.label, "rpi4-01");
  assert.equal(spec.contextValue, "exporter-available");
  assert.equal(spec.category, "available");
  assert.equal(spec.icon.colorId, "charts.green");
  assert.equal(spec.description, "board=rpi4, site=lab1");
});

test("buildExporterItemSpec: held exporter shows leaseholder", () => {
  const spec = buildExporterItemSpec(
    makeExporter({ status: "LEASE_READY", lease: makeLease({ client: "alice" }) }),
  );
  assert.equal(spec.contextValue, "exporter-leased");
  assert.equal(spec.icon.colorId, "charts.green");
  assert.ok(spec.description.startsWith("leased by alice"));
  assert.ok(spec.description.includes("board=rpi4"));
});

test("buildExporterItemSpec: null status (controller without status reporting)", () => {
  const spec = buildExporterItemSpec(makeExporter({ status: null }));
  assert.equal(spec.category, "unknown");
  assert.equal(spec.contextValue, "exporter-unknown");
  assert.ok(spec.description.startsWith("unknown"));
  assert.ok(spec.tooltipMarkdown.includes("`unknown`"));
});

test("buildExporterItemSpec: offline exporter without labels", () => {
  const spec = buildExporterItemSpec(
    makeExporter({ status: "OFFLINE", online: false, labels: {}, deprecated_labels: {} }),
  );
  assert.equal(spec.contextValue, "exporter-offline");
  assert.equal(spec.description, "offline");
});

test("tooltip markdown: status, holder, remaining time and labels table", () => {
  const now = new Date("2026-08-29T12:00:00Z");
  const md = buildExporterTooltipMarkdown(
    makeExporter({
      status: "LEASE_READY",
      lease: makeLease({
        client: "alice",
        duration: 3600,
        effective_begin_time: "2026-08-29T11:30:00Z",
      }),
    }),
    now,
  );
  assert.ok(md.includes("**rpi4-01**"));
  assert.ok(md.includes("Status: `LEASE_READY` (online)"));
  assert.ok(md.includes("Held by: `alice`"));
  assert.ok(md.includes("lease `lease-abc`"));
  assert.ok(md.includes("Time remaining: 30m"));
  assert.ok(md.includes("| Label | Value |"));
  assert.ok(md.includes("| board | rpi4 |"));
});

test("tooltip markdown: no holder section when unleased, escapes pipes", () => {
  const md = buildExporterTooltipMarkdown(makeExporter({ labels: { odd: "a|b" } }));
  assert.ok(!md.includes("Held by"));
  assert.ok(md.includes("a\\|b"));
});

test("tooltip markdown: disabled exporter is flagged", () => {
  const md = buildExporterTooltipMarkdown(makeExporter({ enabled: false }));
  assert.ok(md.includes("(online, disabled)"));
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

test("sortExporters: name-sorted copy, input untouched", () => {
  const input = [
    makeExporter({ name: "b" }),
    makeExporter({ name: "a" }),
    makeExporter({ name: "c" }),
  ];
  const sorted = sortExporters(input);
  assert.deepEqual(
    sorted.map((e) => e.name),
    ["a", "b", "c"],
  );
  assert.equal(input[0].name, "b");
});
