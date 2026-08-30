/**
 * Pure logic for the schemas feature: mapping config files to their JSON
 * schemas and building YAML scaffolds for new client/exporter configs.
 *
 * This module must stay importable without "vscode" so it can be unit-tested
 * with the plain node test runner (see src/test/unit/schemasLogic.test.ts).
 */

import * as path from "path";
import { DriverInfo } from "../../types";

/** Identifies one of the three bundled schemas. */
export type SchemaKind = "client-config" | "exporter-config" | "user-config";

/** Custom URI scheme handed to the Red Hat YAML extension's contributor API. */
export const SCHEMA_URI_SCHEME = "jumpstarter-schema";

/** Fallback location the CLI also reads exporter configs from. */
export const SYSTEM_EXPORTER_CONFIG_DIR = "/etc/jumpstarter/exporters";

/** Schema file name (under the extension's schemas/ directory) for a kind. */
export function schemaFileName(kind: SchemaKind): string {
  return `${kind}.schema.json`;
}

/** URI announced to the YAML extension for a schema kind. */
export function schemaUriForKind(kind: SchemaKind): string {
  return `${SCHEMA_URI_SCHEME}:///${schemaFileName(kind)}`;
}

/** Reverse of schemaUriForKind: extract the kind from a schema URI. */
export function schemaKindForUri(uri: string): SchemaKind | undefined {
  const match = /^jumpstarter-schema:\/{0,3}([a-z-]+)\.schema\.json$/.exec(uri);
  if (match === null) {
    return undefined;
  }
  const kind = match[1];
  if (kind === "client-config" || kind === "exporter-config" || kind === "user-config") {
    return kind;
  }
  return undefined;
}

function isYamlFile(fileName: string): boolean {
  return fileName.endsWith(".yaml") || fileName.endsWith(".yml");
}

/**
 * Decide which schema (if any) applies to a file.
 *
 * Matches, relative to the Jumpstarter config home:
 *   clients/<alias>.yaml    -> client-config
 *   exporters/<alias>.yaml  -> exporter-config
 *   config.yaml             -> user-config
 * plus the CLI's system-wide exporter dir /etc/jumpstarter/exporters.
 */
export function schemaKindForFile(configHome: string, fsPath: string): SchemaKind | undefined {
  const home = path.resolve(configHome);
  const file = path.resolve(fsPath);

  const rel = path.relative(home, file);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    const parts = rel.split(path.sep);
    if (parts.length === 1 && (parts[0] === "config.yaml" || parts[0] === "config.yml")) {
      return "user-config";
    }
    if (parts.length === 2 && isYamlFile(parts[1])) {
      if (parts[0] === "clients") {
        return "client-config";
      }
      if (parts[0] === "exporters") {
        return "exporter-config";
      }
    }
    return undefined;
  }

  const sysRel = path.relative(SYSTEM_EXPORTER_CONFIG_DIR, file);
  if (
    sysRel !== "" &&
    !sysRel.startsWith("..") &&
    !path.isAbsolute(sysRel) &&
    sysRel.split(path.sep).length === 1 &&
    isYamlFile(sysRel)
  ) {
    return "exporter-config";
  }

  return undefined;
}

/** Alias validation for new config files (also used as showInputBox validator). */
export function validateAlias(alias: string): string | undefined {
  if (alias.trim() === "") {
    return "Alias must not be empty.";
  }
  if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(alias)) {
    return "Alias may only contain letters, digits, '.', '_' and '-', and must start and end with a letter or digit.";
  }
  if (alias.length > 128) {
    return "Alias is too long (max 128 characters).";
  }
  return undefined;
}

/** Absolute path where a new client/exporter config for `alias` belongs. */
export function configFilePathForAlias(
  configHome: string,
  kind: "client" | "exporter",
  alias: string,
): string {
  const dir = kind === "client" ? "clients" : "exporters";
  return path.join(path.resolve(configHome), dir, `${alias}.yaml`);
}

export interface ScaffoldOptions {
  alias: string;
  /** metadata.namespace; defaults to "default". */
  namespace?: string;
  /** metadata.name; defaults to the alias. */
  name?: string;
  /** Controller endpoint; defaults to an empty string placeholder. */
  endpoint?: string;
}

function header(lines: string[]): string {
  return lines.map((l) => (l === "" ? "#" : `# ${l}`)).join("\n");
}

/** Minimal valid clients/<alias>.yaml content. */
export function buildClientScaffold(options: ScaffoldOptions): string {
  const namespace = options.namespace ?? "default";
  const name = options.name ?? options.alias;
  const endpoint = options.endpoint ?? "";
  return [
    header([
      "Jumpstarter client configuration.",
      "Fill in the controller endpoint and token, or provision credentials with",
      "`jmp login <endpoint>` / `jmp config client create` instead.",
    ]),
    "apiVersion: jumpstarter.dev/v1alpha1",
    "kind: ClientConfig",
    "metadata:",
    `  namespace: ${yamlString(namespace)}`,
    `  name: ${yamlString(name)}`,
    `endpoint: ${yamlString(endpoint)}`,
    'token: ""',
    "tls:",
    '  ca: ""',
    "  insecure: false",
    "drivers:",
    "  allow: []",
    "  unsafe: false",
    "",
  ].join("\n");
}

export interface ExporterScaffoldOptions extends ScaffoldOptions {
  /**
   * Fully-qualified driver types installed in the active environment
   * (from `jmp driver list -o json`); rendered as a suggestion comment.
   */
  driverTypes?: readonly string[];
}

/** Minimal valid exporters/<alias>.yaml content with a commented export: example. */
export function buildExporterScaffold(options: ExporterScaffoldOptions): string {
  const namespace = options.namespace ?? "default";
  const name = options.name ?? options.alias;
  const endpoint = options.endpoint ?? "";

  const lines: string[] = [
    header([
      "Jumpstarter exporter configuration.",
      "Fill in the controller endpoint and token, then declare the drivers this",
      "exporter exposes under `export:`.",
    ]),
    "apiVersion: jumpstarter.dev/v1alpha1",
    "kind: ExporterConfig",
    "metadata:",
    `  namespace: ${yamlString(namespace)}`,
    `  name: ${yamlString(name)}`,
    `endpoint: ${yamlString(endpoint)}`,
    'token: ""',
    "tls:",
    '  ca: ""',
    "  insecure: false",
    "export: {}",
    "",
    "# Example export block — replace `export: {}` above with something like:",
    "#",
    "# export:",
    "#   power:",
    "#     type: jumpstarter_driver_power.driver.MockPower",
    "#     config: {}",
    "#   storage:",
    "#     type: jumpstarter_driver_opendal.driver.MockStorageMux",
  ];

  const types = dedupeSorted(options.driverTypes ?? []);
  if (types.length > 0) {
    lines.push("#");
    lines.push("# Driver types installed in the active environment (`jmp driver list`):");
    for (const t of types) {
      lines.push(`#   ${t}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Extract the sorted, de-duplicated driver type strings from driver list output. */
export function driverTypesFromList(drivers: readonly DriverInfo[]): string[] {
  return dedupeSorted(drivers.map((d) => d.type));
}

function dedupeSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((v) => v !== ""))).sort();
}

/** Quote a scalar for safe inclusion in the scaffold YAML. */
export function yamlString(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
