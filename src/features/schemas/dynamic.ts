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
const DRIVER_INSTANCE = "ExporterConfigV1Alpha1DriverInstance";

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

/** A definition name unique to one driver, so two drivers cannot collide. */
export function defsPrefixFor(driver: DriverSchema): string {
  return `${driver.type.replace(/[^A-Za-z0-9]+/g, "_")}__`;
}

/**
 * Rewrite every "#/$defs/X" reference in a fragment to "#/$defs/<prefix>X".
 *
 * Driver schemas reference their own definitions; those definitions are merged
 * into the host schema under prefixed names, so the references have to move
 * with them or they dangle.
 */
export function namespaceRefs(node: unknown, prefix: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => namespaceRefs(item, prefix));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
      out[key] = `#/$defs/${prefix}${value.slice("#/$defs/".length)}`;
    } else {
      out[key] = namespaceRefs(value, prefix);
    }
  }
  return out;
}

/** One driver's definitions, renamed and re-pointed under its own prefix. */
export function namespacedDefs(driver: DriverSchema): Record<string, JsonSchema> {
  const prefix = defsPrefixFor(driver);
  const out: Record<string, JsonSchema> = {};
  for (const [name, definition] of Object.entries(driver.defs ?? {})) {
    out[`${prefix}${name}`] = namespaceRefs(definition, prefix) as JsonSchema;
  }
  return out;
}

/**
 * The `config:` sub-schema for one driver.
 *
 * `additionalProperties` stays open: a driver whose keys could only be
 * recovered from its dataclass may be described incompletely, and rejecting
 * unknown keys there would flag valid configs.
 *
 * `required` is deliberately not emitted. The YAML language server answers a
 * schema with unmet required keys by adding a "fill in the whole object"
 * snippet to the completion list, which crowds out the keys themselves; the
 * requirement is carried in each key's documentation instead.
 */
export function configSchemaFor(driver: DriverSchema): JsonSchema {
  const prefix = defsPrefixFor(driver);
  const required = new Set(driver.required ?? []);
  const properties = namespaceRefs(clone(driver.properties ?? {}), prefix) as Record<
    string,
    JsonSchema
  >;
  for (const [name, property] of Object.entries(properties)) {
    if (required.has(name)) {
      const existing = typeof property.description === "string" ? `\n\n${property.description}` : "";
      property.markdownDescription = `**Required.**${existing}`;
    }
  }
  return {
    type: "object",
    properties,
    additionalProperties: true,
  };
}

/** Name of the generated union of driver instances, added to the schema's $defs. */
export const DRIVER_INSTANCE_UNION = "JumpstarterDriverInstance";

/**
 * Inject installed driver types and their config keys into the exporter schema.
 *
 * Every driver becomes one branch of a union: `type` is a const (so it
 * completes with the driver's documentation) and `config` carries that
 * driver's own keys. A final guarded branch keeps the original permissive
 * shape for anything else — composite and proxy nodes, and drivers installed
 * on the exporter host but not here.
 *
 * The shape is dictated by what the YAML language server can actually resolve,
 * established by probing it directly:
 *   - `if`/`then` branches never produce completions, so the discriminator has
 *     to be a `const` inside a union branch;
 *   - an *unguarded* permissive branch in that union silently suppresses
 *     completions for every other branch, so the fallback is guarded by
 *     `type: {not: {enum: [...known]}}` and cannot overlap a known driver.
 */
export function withDriverCompletions(baseSchema: JsonSchema, drivers: DriverSchema[]): JsonSchema {
  const schema = clone(baseSchema);
  const defs = schema.$defs as Record<string, JsonSchema> | undefined;
  const instance = defs?.[DRIVER_INSTANCE_BASE];
  const exportProperty = (schema.properties as Record<string, JsonSchema> | undefined)?.export;
  if (!defs || !instance || !exportProperty || drivers.length === 0) {
    return schema;
  }

  const baseProperties = (instance.properties ?? {}) as Record<string, JsonSchema>;
  const sorted = [...drivers].sort((a, b) => a.type.localeCompare(b.type));
  const unionRef = { $ref: `#/$defs/${DRIVER_INSTANCE_UNION}` };

  const variants: JsonSchema[] = sorted.map((driver) => {
    const documentation = driverDocumentation(driver);
    const hasConfig = Object.keys(driver.properties ?? {}).length > 0;
    return {
      type: "object",
      title: driver.name,
      ...(documentation ? { markdownDescription: documentation } : {}),
      properties: {
        ...clone(baseProperties),
        type: {
          const: driver.type,
          ...(documentation ? { markdownDescription: documentation } : {}),
        },
        ...(hasConfig ? { config: configSchemaFor(driver) } : {}),
        // Nested children complete the same way as top-level exports.
        children: { type: "object", additionalProperties: unionRef },
      },
      required: ["type"],
    };
  });

  // Composite nodes, proxies, and drivers this environment does not have.
  // Guarded so it can never match a type that has its own branch above.
  const fallback: JsonSchema = {
    allOf: [
      { $ref: `#/$defs/${DRIVER_INSTANCE}` },
      { properties: { type: { not: { enum: sorted.map((d) => d.type) } } } },
    ],
  };

  defs[DRIVER_INSTANCE_UNION] = { anyOf: [...variants, fallback] };
  exportProperty.additionalProperties = unionRef;

  // Definitions the driver configs reference travel with them, prefixed per
  // driver so identically named models from two drivers cannot collide.
  for (const driver of sorted) {
    Object.assign(defs, namespacedDefs(driver));
  }

  return schema;
}

/** One completion offered for `drivers.allow`, with what it lets through. */
export interface AllowEntry {
  value: string;
  documentation: string;
}

/**
 * Entries for `drivers.allow` in a client config.
 *
 * The allow list is matched against each driver's *client* class, so both the
 * package-wide glob and the individual client classes are offered — the glob
 * for "trust this package", the exact classes for a narrower list.
 */
export function driverAllowEntries(drivers: DriverSchema[]): AllowEntry[] {
  const packages = new Map<string, Set<string>>();
  const clients = new Map<string, string[]>();

  for (const driver of drivers) {
    const clientClass = driver.client ?? undefined;
    const root = (clientClass ?? driver.type).split(".")[0];
    if (!root) {
      continue;
    }
    const names = packages.get(root) ?? new Set<string>();
    names.add(driver.name);
    packages.set(root, names);

    if (clientClass) {
      clients.set(clientClass, [...(clients.get(clientClass) ?? []), driver.name]);
    }
  }

  const globs: AllowEntry[] = [...packages.entries()]
    .map(([root, names]) => ({
      value: `${root}.*`,
      documentation: `Every driver client in \`${root}\` (${[...names].sort().join(", ")})`,
    }))
    .sort((a, b) => a.value.localeCompare(b.value));

  const exact: AllowEntry[] = [...clients.entries()]
    .map(([clientClass, names]) => ({
      value: clientClass,
      documentation: `Client for ${[...new Set(names)].sort().join(", ")}`,
    }))
    .sort((a, b) => a.value.localeCompare(b.value));

  return [...globs, ...exact];
}

/** Package globs only — kept for callers that just want the coarse patterns. */
export function driverAllowPatterns(drivers: DriverSchema[]): string[] {
  return driverAllowEntries(drivers)
    .filter((entry) => entry.value.endsWith(".*"))
    .map((entry) => entry.value);
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

  const entries = driverAllowEntries(drivers);
  allow.items = {
    anyOf: [
      {
        enum: [...entries.map((e) => e.value), "UNSAFE"],
        markdownEnumDescriptions: [
          ...entries.map((e) => e.documentation),
          "Allow every driver client package (unsafe)",
        ],
      },
      { type: "string" },
    ],
  };
  return schema;
}
