/**
 * Unit tests for venv-aware schema generation (src/features/schemas/dynamic).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  configSchemaFor,
  driverAllowPatterns,
  driverDocumentation,
  withDriverAllowCompletions,
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

test("withDriverCompletions: offers installed types but still accepts any string", () => {
  const out = withDriverCompletions(EXPORTER_SCHEMA, [makeDriver()]);
  const typeProp = instanceBase(out).properties.type;
  assert.deepEqual(typeProp.anyOf[0].enum, ["jumpstarter_driver_network.driver.TcpNetwork"]);
  assert.equal(typeProp.anyOf[0].markdownEnumDescriptions.length, 1);
  // A driver installed only on the exporter host must not be flagged invalid.
  assert.deepEqual(typeProp.anyOf[1], { type: "string" });
});

test("withDriverCompletions: adds a config branch per driver type", () => {
  const out = withDriverCompletions(EXPORTER_SCHEMA, [makeDriver()]);
  const [branch] = instanceBase(out).allOf;
  assert.equal(
    branch.if.properties.type.const,
    "jumpstarter_driver_network.driver.TcpNetwork",
  );
  assert.deepEqual(Object.keys(branch.then.properties.config.properties), ["host", "port"]);
  assert.deepEqual(branch.then.properties.config.required, ["host", "port"]);
});

test("withDriverCompletions: drivers without config keys get no branch", () => {
  const out = withDriverCompletions(EXPORTER_SCHEMA, [
    makeDriver({ name: "MockPower", type: "m.MockPower", properties: {}, required: [] }),
  ]);
  assert.deepEqual(instanceBase(out).allOf, []);
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

test("configSchemaFor: stays open to keys we could not describe", () => {
  const schema = configSchemaFor(makeDriver({ required: [] }));
  assert.equal(schema.additionalProperties, true);
  assert.equal("required" in schema, false);
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

test("withDriverAllowCompletions: completes packages plus UNSAFE", () => {
  const out = withDriverAllowCompletions(CLIENT_SCHEMA, [makeDriver()]);
  const items = (out.$defs as Record<string, any>).ClientConfigV1Alpha1Drivers.properties.allow
    .items;
  assert.deepEqual(items.anyOf[0].enum, ["jumpstarter_driver_network.*", "UNSAFE"]);
  assert.deepEqual(items.anyOf[1], { type: "string" });
});
