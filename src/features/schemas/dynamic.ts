/**
 * Turning the bundled static schemas into venv-aware ones.
 *
 * Rather than running a language server of our own, the schemas handed to the
 * YAML extension are rebuilt from the drivers installed in the active Python
 * environment. That gives completion, hover docs and validation for
 * `export:` driver types, their `config:` keys, and `drivers.allow` — all from
 * machinery the YAML extension already provides.
 *
 * Pure and VS Code-free so it can be unit-tested under plain Node.
 */

import { DriverSchema } from "../../types";

/** JSON Schema fragments are plain data; the shapes are not worth modelling. */
type JsonSchema = Record<string, unknown>;

const DRIVER_INSTANCE_BASE = "ExporterConfigV1Alpha1DriverInstanceBase";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Markdown shown when hovering or completing a driver type. */
export function driverDocumentation(driver: DriverSchema): string {
  const lines: string[] = [];
  if (driver.description) {
    lines.push(driver.description);
  }
  if (driver.package) {
    lines.push(`Package: \`${driver.package}\`${driver.version ? ` ${driver.version}` : ""}`);
  }
  const keys = Object.keys(driver.properties ?? {});
  if (keys.length > 0) {
    const required = new Set(driver.required ?? []);
    const rendered = keys.map((k) => (required.has(k) ? `**${k}**` : k));
    lines.push(`Config keys: ${rendered.join(", ")}`);
  }
  if (driver.error) {
    lines.push(`Note: this driver could not be fully inspected (${driver.error}).`);
  }
  return lines.join("\n\n");
}

/**
 * The `config:` sub-schema for one driver.
 *
 * `additionalProperties` stays open: a driver whose keys could only be
 * recovered from its dataclass may be described incompletely, and rejecting
 * unknown keys there would flag valid configs.
 */
export function configSchemaFor(driver: DriverSchema): JsonSchema {
  return {
    type: "object",
    properties: clone(driver.properties ?? {}),
    ...(driver.required && driver.required.length > 0 ? { required: [...driver.required] } : {}),
    additionalProperties: true,
  };
}

/**
 * Inject installed driver types and their config keys into the exporter schema.
 *
 * The `type` key gains a completable list of installed types while still
 * accepting any string, since an exporter config may legitimately name a
 * driver installed elsewhere. Each known type then contributes an
 * `if type == X then config: {...}` branch.
 */
export function withDriverCompletions(baseSchema: JsonSchema, drivers: DriverSchema[]): JsonSchema {
  const schema = clone(baseSchema);
  const defs = schema.$defs as Record<string, JsonSchema> | undefined;
  const instance = defs?.[DRIVER_INSTANCE_BASE];
  if (!instance || drivers.length === 0) {
    return schema;
  }

  const properties = instance.properties as Record<string, JsonSchema> | undefined;
  if (!properties?.type) {
    return schema;
  }

  const sorted = [...drivers].sort((a, b) => a.type.localeCompare(b.type));
  properties.type = {
    title: "Type",
    description: "Driver class path, e.g. jumpstarter_driver_power.driver.MockPower",
    anyOf: [
      {
        enum: sorted.map((d) => d.type),
        // Per-value hover/completion detail, honoured by the YAML server.
        markdownEnumDescriptions: sorted.map((d) => driverDocumentation(d)),
      },
      { type: "string" },
    ],
  };

  instance.allOf = sorted
    .filter((driver) => Object.keys(driver.properties ?? {}).length > 0)
    .map((driver) => ({
      if: { properties: { type: { const: driver.type } }, required: ["type"] },
      then: { properties: { config: configSchemaFor(driver) } },
    }));

  return schema;
}

/**
 * Glob patterns matching the client packages of installed drivers, for
 * `drivers.allow` in a client config (e.g. "jumpstarter_driver_power.*").
 */
export function driverAllowPatterns(drivers: DriverSchema[]): string[] {
  const patterns = new Set<string>();
  for (const driver of drivers) {
    const root = driver.type.split(".")[0];
    if (root) {
      patterns.add(`${root}.*`);
    }
  }
  return [...patterns].sort();
}

/**
 * Inject the installed driver packages into a client schema's `drivers.allow`.
 *
 * "UNSAFE" is offered too: the CLI treats it as "allow every package".
 */
export function withDriverAllowCompletions(
  baseSchema: JsonSchema,
  drivers: DriverSchema[],
): JsonSchema {
  const schema = clone(baseSchema);
  const defs = schema.$defs as Record<string, JsonSchema> | undefined;
  const driversDef = defs?.ClientConfigV1Alpha1Drivers;
  const properties = driversDef?.properties as Record<string, JsonSchema> | undefined;
  const allow = properties?.allow;
  if (!allow || drivers.length === 0) {
    return schema;
  }

  const patterns = driverAllowPatterns(drivers);
  allow.items = {
    anyOf: [
      {
        enum: [...patterns, "UNSAFE"],
        markdownEnumDescriptions: [
          ...patterns.map((p) => `Allow driver clients from \`${p.replace(".*", "")}\``),
          "Allow every driver client package (unsafe)",
        ],
      },
      { type: "string" },
    ],
  };
  return schema;
}
