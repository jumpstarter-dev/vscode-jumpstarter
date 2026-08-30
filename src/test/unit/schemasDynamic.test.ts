/**
 * Unit tests for venv-aware schema generation (src/features/schemas/dynamic).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  configSchemaFor,
  driverAllowEntries,
  driverAllowPatterns,
  driverDocumentation,
  withDriverAllowCompletions,
  namespaceRefs,
  withDriverCompletions,
} from "../../features/schemas/dynamic";
import { DriverSchema } from "../../types";

function makeDriver(overrides: Partial<DriverSchema> = {}): DriverSchema {
  return {
    name: "TcpNetwork",
    type: "jumpstarter_driver_network.driver.TcpNetwork",
    package: "jumpstarter-driver-network",
    version: "0.10.0",
    description: "TcpNetwork is a driver for connecting to TCP sockets",
    properties: {
      host: { title: "Host", type: "string" },
      port: { title: "Port", type: "integer" },
    },
    required: ["host", "port"],
    error: null,
    ...overrides,
  };
}

const EXPORTER_SCHEMA = {
  type: "object",
  properties: { export: { additionalProperties: { $ref: "#/$defs/X" } } },
  $defs: {
    ExporterConfigV1Alpha1DriverInstance: { anyOf: [{ type: "object" }] },
    ExporterConfigV1Alpha1DriverInstanceBase: {
      type: "object",
      properties: {
        type: { title: "Type", type: "string" },
        config: { title: "Config", type: "object" },
        children: { title: "Children", type: "object" },
      },
    },
  },
};

const CLIENT_SCHEMA = {
  type: "object",
  $defs: {
    ClientConfigV1Alpha1Drivers: {
      type: "object",
      properties: {
        allow: { title: "Allow", type: "array", items: { type: "string" } },
        unsafe: { title: "Unsafe", type: "boolean" },
      },
    },
  },
};

function instanceBase(schema: Record<string, unknown>): Record<string, any> {
  return (schema.$defs as Record<string, any>).ExporterConfigV1Alpha1DriverInstanceBase;
}

function union(schema: Record<string, unknown>): Record<string, any> {
  return (schema.$defs as Record<string, any>).JumpstarterDriverInstance;
}

function variantFor(schema: Record<string, unknown>, type: string): Record<string, any> {
  return union(schema).anyOf.find((v: any) => v.properties?.type?.const === type);
}

test("withDriverCompletions: one union branch per installed driver", () => {
  const out = withDriverCompletions(EXPORTER_SCHEMA, [makeDriver()]);
  const variant = variantFor(out, "jumpstarter_driver_network.driver.TcpNetwork");
  assert.ok(variant);
  assert.deepEqual(variant.required, ["type"]);
  assert.match(variant.markdownDescription, /TCP sockets/);
  // export nodes resolve through the generated union.
  assert.deepEqual((out.properties as any).export.additionalProperties, {
    $ref: "#/$defs/JumpstarterDriverInstance",
  });
});

test("withDriverCompletions: a branch carries that driver's config keys", () => {
  const out = withDriverCompletions(EXPORTER_SCHEMA, [makeDriver()]);
  const variant = variantFor(out, "jumpstarter_driver_network.driver.TcpNetwork");
  assert.deepEqual(Object.keys(variant.properties.config.properties), ["host", "port"]);
});

test("configSchemaFor: required keys are documented, not declared", () => {
  // A schema with unmet required keys makes the YAML server offer a
  // fill-in-the-object snippet that crowds out the key completions.
  const schema = configSchemaFor(makeDriver());
  assert.equal("required" in schema, false);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.match(String(properties.host.markdownDescription), /Required/);
  assert.equal(properties.port.markdownDescription, "**Required.**");
});

test("withDriverCompletions: drivers without config keys still get a branch", () => {
  const out = withDriverCompletions(EXPORTER_SCHEMA, [
    makeDriver({ name: "MockPower", type: "m.MockPower", properties: {}, required: [] }),
  ]);
  const variant = variantFor(out, "m.MockPower");
  assert.ok(variant, "the type must still complete");
  // The generic config key from the base definition is still offered; there
  // are simply no known keys to complete inside it.
  assert.equal(variant.properties.config.properties, undefined);
});

test("withDriverCompletions: nested children resolve through the same union", () => {
  const out = withDriverCompletions(EXPORTER_SCHEMA, [makeDriver()]);
  const variant = variantFor(out, "jumpstarter_driver_network.driver.TcpNetwork");
  assert.deepEqual(variant.properties.children.additionalProperties, {
    $ref: "#/$defs/JumpstarterDriverInstance",
  });
});

test("withDriverCompletions: the fallback cannot overlap a known driver type", () => {
  // An unguarded permissive branch suppresses completions for every other
  // branch in the YAML language server, so the guard is load-bearing.
  const out = withDriverCompletions(EXPORTER_SCHEMA, [makeDriver()]);
  const fallback = union(out).anyOf.at(-1);
  assert.deepEqual(fallback.allOf[0], {
    $ref: "#/$defs/ExporterConfigV1Alpha1DriverInstance",
  });
  assert.deepEqual(fallback.allOf[1].properties.type.not.enum, [
    "jumpstarter_driver_network.driver.TcpNetwork",
  ]);
});

test("withDriverCompletions: leaves the schema alone when nothing is installed", () => {
  const out = withDriverCompletions(EXPORTER_SCHEMA, []);
  assert.deepEqual(out, EXPORTER_SCHEMA);
});

test("withDriverCompletions: does not mutate the input schema", () => {
  const before = JSON.stringify(EXPORTER_SCHEMA);
  withDriverCompletions(EXPORTER_SCHEMA, [makeDriver()]);
  assert.equal(JSON.stringify(EXPORTER_SCHEMA), before);
});

test("withDriverCompletions: driver definitions travel with their refs", () => {
  const driver = makeDriver({
    name: "Xcp",
    type: "jumpstarter_driver_xcp.driver.Xcp",
    properties: { protocol: { $ref: "#/$defs/XcpEthProtocol" } },
    required: [],
    defs: { XcpEthProtocol: { enum: ["TCP", "UDP"], title: "XcpEthProtocol" } },
  });
  const out = withDriverCompletions(EXPORTER_SCHEMA, [driver]);
  const defs = out.$defs as Record<string, unknown>;
  const prefix = "jumpstarter_driver_xcp_driver_Xcp__";
  const variant = variantFor(out, "jumpstarter_driver_xcp.driver.Xcp");

  // Every ref in the generated document must resolve inside it, or the YAML
  // server reports "$ref ... cannot be resolved" over the whole file.
  assert.equal(variant.properties.config.properties.protocol.$ref, `#/$defs/${prefix}XcpEthProtocol`);
  assert.ok(defs[`${prefix}XcpEthProtocol`]);
});

test("withDriverCompletions: same-named defs from two drivers do not collide", () => {
  const a = makeDriver({
    type: "pkg_a.driver.A",
    properties: { mode: { $ref: "#/$defs/Mode" } },
    required: [],
    defs: { Mode: { enum: ["a1", "a2"] } },
  });
  const b = makeDriver({
    type: "pkg_b.driver.B",
    properties: { mode: { $ref: "#/$defs/Mode" } },
    required: [],
    defs: { Mode: { enum: ["b1", "b2"] } },
  });
  const out = withDriverCompletions(EXPORTER_SCHEMA, [a, b]);
  const defs = out.$defs as Record<string, any>;
  assert.deepEqual(defs["pkg_a_driver_A__Mode"].enum, ["a1", "a2"]);
  assert.deepEqual(defs["pkg_b_driver_B__Mode"].enum, ["b1", "b2"]);
});

test("namespaceRefs: rewrites nested refs and leaves other strings alone", () => {
  const input = {
    items: { $ref: "#/$defs/Thing" },
    other: { $ref: "https://example.com/x.json" },
    list: [{ $ref: "#/$defs/Deep" }],
    title: "#/$defs/NotARef",
  };
  const out = namespaceRefs(input, "P__") as Record<string, any>;
  assert.equal(out.items.$ref, "#/$defs/P__Thing");
  assert.equal(out.other.$ref, "https://example.com/x.json");
  assert.equal(out.list[0].$ref, "#/$defs/P__Deep");
  assert.equal(out.title, "#/$defs/NotARef");
});

test("configSchemaFor: stays open to keys we could not describe", () => {
  const schema = configSchemaFor(makeDriver({ required: [] }));
  assert.equal(schema.additionalProperties, true);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.host.markdownDescription, undefined);
});

test("driverDocumentation: describes the driver, package and keys", () => {
  const doc = driverDocumentation(makeDriver());
  assert.match(doc, /TCP sockets/);
  assert.match(doc, /jumpstarter-driver-network/);
  // Required keys are emphasized.
  assert.match(doc, /\*\*host\*\*/);
});

test("driverDocumentation: notes a driver that could not be inspected", () => {
  const doc = driverDocumentation(makeDriver({ error: "PydanticSchemaGenerationError: nope" }));
  assert.match(doc, /could not be fully inspected/);
});

test("driverAllowPatterns: one glob per driver package root", () => {
  const patterns = driverAllowPatterns([
    makeDriver(),
    makeDriver({ type: "jumpstarter_driver_power.driver.MockPower" }),
    makeDriver({ type: "jumpstarter_driver_power.driver.PduPower" }),
  ]);
  assert.deepEqual(patterns, ["jumpstarter_driver_network.*", "jumpstarter_driver_power.*"]);
});

test("withDriverAllowCompletions: completes packages, client classes and UNSAFE", () => {
  const out = withDriverAllowCompletions(CLIENT_SCHEMA, [
    makeDriver({ client: "jumpstarter_driver_network.client.NetworkClient" }),
    makeDriver({
      name: "MockPower",
      type: "jumpstarter_driver_power.driver.MockPower",
      client: "jumpstarter_driver_power.client.PowerClient",
    }),
  ]);
  const items = (out.$defs as Record<string, any>).ClientConfigV1Alpha1Drivers.properties.allow
    .items;
  assert.deepEqual(items.anyOf[0].enum, [
    "jumpstarter_driver_network.*",
    "jumpstarter_driver_power.*",
    "jumpstarter_driver_network.client.NetworkClient",
    "jumpstarter_driver_power.client.PowerClient",
    "UNSAFE",
  ]);
  assert.deepEqual(items.anyOf[1], { type: "string" });
});

test("driverAllowEntries: globs come from the client package, not the driver one", () => {
  const entries = driverAllowEntries([
    makeDriver({ client: "jumpstarter_driver_network.client.NetworkClient" }),
  ]);
  assert.deepEqual(
    entries.map((e) => e.value),
    ["jumpstarter_driver_network.*", "jumpstarter_driver_network.client.NetworkClient"],
  );
  assert.match(entries[0].documentation, /TcpNetwork/);
});

test("driverAllowEntries: a driver with no client class still yields its package", () => {
  const entries = driverAllowEntries([makeDriver({ client: null })]);
  assert.deepEqual(
    entries.map((e) => e.value),
    ["jumpstarter_driver_network.*"],
  );
});
