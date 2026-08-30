/**
 * Unit tests for the schemas feature's pure logic. Run with `pnpm run
 * test:unit` (node --test on compiled output) — no VS Code host required.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildClientScaffold,
  buildExporterScaffold,
  configFilePathForAlias,
  driverTypesFromList,
  schemaFileName,
  schemaKindForFile,
  schemaKindForUri,
  schemaUriForKind,
  validateAlias,
  yamlString,
} from "../../features/schemas/logic";
import { DriverInfo } from "../../types";

const HOME = "/home/user/.config/jumpstarter";

// ---------------------------------------------------------------------------
// Schema/file matching
// ---------------------------------------------------------------------------

test("schemaKindForFile: clients/*.yaml is client-config", () => {
  assert.equal(schemaKindForFile(HOME, `${HOME}/clients/dev.yaml`), "client-config");
  assert.equal(schemaKindForFile(HOME, `${HOME}/clients/dev.yml`), "client-config");
});

test("schemaKindForFile: exporters/*.yaml is exporter-config", () => {
  assert.equal(schemaKindForFile(HOME, `${HOME}/exporters/rig-1.yaml`), "exporter-config");
});

test("schemaKindForFile: system exporter dir matches exporter-config", () => {
  assert.equal(
    schemaKindForFile(HOME, "/etc/jumpstarter/exporters/rig.yaml"),
    "exporter-config",
  );
});

test("schemaKindForFile: config.yaml is user-config", () => {
  assert.equal(schemaKindForFile(HOME, `${HOME}/config.yaml`), "user-config");
});

test("schemaKindForFile: unrelated files do not match", () => {
  assert.equal(schemaKindForFile(HOME, "/home/user/project/config.yaml"), undefined);
  assert.equal(schemaKindForFile(HOME, `${HOME}/clients/dev.json`), undefined);
  assert.equal(schemaKindForFile(HOME, `${HOME}/clients/nested/dev.yaml`), undefined);
  assert.equal(schemaKindForFile(HOME, `${HOME}/other/dev.yaml`), undefined);
  assert.equal(schemaKindForFile(HOME, `${HOME}/clients`), undefined);
  // Sibling directory whose name shares the prefix must not match.
  assert.equal(
    schemaKindForFile(HOME, "/home/user/.config/jumpstarter-evil/clients/dev.yaml"),
    undefined,
  );
});

test("schemaKindForFile: normalizes relative segments", () => {
  assert.equal(
    schemaKindForFile(HOME, `${HOME}/clients/../clients/dev.yaml`),
    "client-config",
  );
});

// ---------------------------------------------------------------------------
// Schema URIs
// ---------------------------------------------------------------------------

test("schemaUriForKind round-trips through schemaKindForUri", () => {
  for (const kind of ["client-config", "exporter-config", "user-config"] as const) {
    assert.equal(schemaKindForUri(schemaUriForKind(kind)), kind);
  }
});

test("schemaKindForUri rejects foreign URIs", () => {
  assert.equal(schemaKindForUri("file:///tmp/x.schema.json"), undefined);
  assert.equal(schemaKindForUri("jumpstarter-schema:///nope.schema.json"), undefined);
});

test("schemaFileName maps kinds to bundled files", () => {
  assert.equal(schemaFileName("client-config"), "client-config.schema.json");
  assert.equal(schemaFileName("exporter-config"), "exporter-config.schema.json");
  assert.equal(schemaFileName("user-config"), "user-config.schema.json");
});

// ---------------------------------------------------------------------------
// Alias validation and paths
// ---------------------------------------------------------------------------

test("validateAlias accepts reasonable aliases", () => {
  assert.equal(validateAlias("dev"), undefined);
  assert.equal(validateAlias("my-client_2.prod"), undefined);
  assert.equal(validateAlias("A1"), undefined);
});

test("validateAlias rejects empty, path-ish, and edge-punctuated aliases", () => {
  assert.notEqual(validateAlias(""), undefined);
  assert.notEqual(validateAlias("  "), undefined);
  assert.notEqual(validateAlias("../evil"), undefined);
  assert.notEqual(validateAlias("a/b"), undefined);
  assert.notEqual(validateAlias("-dash"), undefined);
  assert.notEqual(validateAlias("dot."), undefined);
  assert.notEqual(validateAlias("has space"), undefined);
  assert.notEqual(validateAlias("x".repeat(129)), undefined);
});

test("configFilePathForAlias builds the expected paths", () => {
  assert.equal(
    configFilePathForAlias(HOME, "client", "dev"),
    `${HOME}/clients/dev.yaml`,
  );
  assert.equal(
    configFilePathForAlias(HOME, "exporter", "rig-1"),
    `${HOME}/exporters/rig-1.yaml`,
  );
});

// ---------------------------------------------------------------------------
// Scaffolds
// ---------------------------------------------------------------------------

test("client scaffold is minimal, valid-shaped YAML with the alias as name", () => {
  const text = buildClientScaffold({ alias: "dev" });
  assert.match(text, /^apiVersion: jumpstarter\.dev\/v1alpha1$/m);
  assert.match(text, /^kind: ClientConfig$/m);
  assert.match(text, /^ {2}namespace: default$/m);
  assert.match(text, /^ {2}name: dev$/m);
  assert.match(text, /^token: ""$/m); // placeholder only — never a real credential
  assert.ok(text.endsWith("\n"));
});

test("client scaffold honors explicit metadata and endpoint", () => {
  const text = buildClientScaffold({
    alias: "dev",
    namespace: "lab",
    name: "client-a",
    endpoint: "grpc.lab.example.com:443",
  });
  assert.match(text, /^ {2}namespace: lab$/m);
  assert.match(text, /^ {2}name: client-a$/m);
  assert.match(text, /^endpoint: grpc\.lab\.example\.com:443$/m);
});

test("exporter scaffold includes kind, commented export example, and driver types", () => {
  const text = buildExporterScaffold({
    alias: "rig",
    driverTypes: ["b.driver.B", "a.driver.A", "a.driver.A", ""],
  });
  assert.match(text, /^kind: ExporterConfig$/m);
  assert.match(text, /^export: \{\}$/m);
  assert.match(text, /^# export:$/m); // commented example block
  assert.match(text, /^# {3}power:$/m);
  assert.match(text, /^# {5}type: jumpstarter_driver_power\.driver\.MockPower$/m);
  // Driver type suggestions: deduped, sorted, empties dropped.
  const aIndex = text.indexOf("#   a.driver.A");
  const bIndex = text.indexOf("#   b.driver.B");
  assert.ok(aIndex !== -1 && bIndex !== -1 && aIndex < bIndex);
  assert.equal(text.match(/a\.driver\.A/g)?.length, 1);
});

test("exporter scaffold omits the driver-types block when none are known", () => {
  const text = buildExporterScaffold({ alias: "rig" });
  assert.ok(!text.includes("installed in the active environment"));
  assert.match(text, /^# export:$/m); // static example still present
});

test("driverTypesFromList extracts sorted unique types", () => {
  const drivers: DriverInfo[] = [
    { name: "B", type: "pkg_b.driver.B", package: "pkg-b", version: "1" },
    { name: "A", type: "pkg_a.driver.A", package: "pkg-a", version: "1" },
    { name: "A2", type: "pkg_a.driver.A", package: "pkg-a", version: "1" },
  ];
  assert.deepEqual(driverTypesFromList(drivers), ["pkg_a.driver.A", "pkg_b.driver.B"]);
});

test("yamlString quotes values that are not plain scalars", () => {
  assert.equal(yamlString("grpc.example.com:443"), "grpc.example.com:443");
  assert.equal(yamlString("plain-name_1"), "plain-name_1");
  assert.equal(yamlString("has space"), '"has space"');
  assert.equal(yamlString("y: es"), '"y: es"');
  assert.equal(yamlString(""), '""');
  assert.equal(yamlString("-leading"), '"-leading"');
});
