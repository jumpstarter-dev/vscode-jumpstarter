/**
 * Binds the JSON schemas to Jumpstarter YAML config files via the Red Hat YAML
 * extension's schema-contributor API.
 *
 * The bundled schemas describe the config structure; before serving them the
 * drivers installed in the active Python environment are folded in, so
 * `export:` types, their `config:` keys and `drivers.allow` complete against
 * the environment this project actually uses. Switching interpreters changes
 * the schema version in the URI, which the YAML server treats as a new schema.
 *
 * If the YAML extension (redhat.vscode-yaml) is not installed the feature
 * degrades silently; if it gets installed later (extensions change event)
 * the contributor is registered then.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";

import { DriverSchema } from "../../types";
import { withDriverAllowCompletions, withDriverCompletions } from "./dynamic";
import {
  SCHEMA_URI_SCHEME,
  SchemaKind,
  schemaFileName,
  schemaKindForFile,
  schemaKindForUri,
  schemaUriForKind,
} from "./logic";

const YAML_EXTENSION_ID = "redhat.vscode-yaml";

/** The (undocumented-but-stable) API exported by redhat.vscode-yaml. */
interface YamlExtensionApi {
  registerContributor(
    /**
     * The URI *scheme* this contributor serves — not a display name. Schema
     * URIs returned by requestSchema are routed back to requestSchemaContent
     * only when their scheme matches this value.
     */
    scheme: string,
    requestSchema: (resource: string) => string | undefined,
    requestSchemaContent?: (uri: string) => Promise<string> | string,
    label?: string,
  ): boolean;
}

function isYamlExtensionApi(api: unknown): api is YamlExtensionApi {
  return (
    typeof api === "object" &&
    api !== null &&
    typeof (api as YamlExtensionApi).registerContributor === "function"
  );
}

export interface YamlAssociationDeps {
  /** Jumpstarter config home directory (ConfigWatcher.configHome). */
  configHome: string;
  /** Resolves a bundled schema file to its absolute path (context.asAbsolutePath). */
  schemaPath(fileName: string): string;
  /**
   * Driver config schemas for the active environment, or [] when they cannot
   * be read (no jmp, an older CLI without `driver schema`, a load failure) —
   * the static schema is still served in that case.
   */
  loadDrivers(): Promise<DriverSchema[]>;
  /** Fires when the environment changed, so generated schemas must be rebuilt. */
  onDidChangeEnvironment: vscode.Event<unknown>;
  /** Diagnostics. */
  log(message: string): void;
}

/**
 * Register the schema contributor with the YAML extension when present.
 * Returns a Disposable that stops the listeners (an already registered
 * contributor cannot be unregistered — that is fine, the callbacks become
 * inert when the extension host disposes).
 */
export function activateYamlAssociation(deps: YamlAssociationDeps): vscode.Disposable {
  let registered = false;
  // Bumped whenever the environment changes; part of the schema URI so the
  // YAML server re-requests content instead of serving a stale generation.
  let generation = 0;
  let cached: Promise<Map<SchemaKind, string>> | undefined;

  const buildSchemas = async (): Promise<Map<SchemaKind, string>> => {
    const read = async (kind: SchemaKind): Promise<unknown> =>
      JSON.parse(await fs.readFile(deps.schemaPath(schemaFileName(kind)), "utf8"));

    const [client, exporter, user] = await Promise.all([
      read("client-config"),
      read("exporter-config"),
      read("user-config"),
    ]);

    let drivers: DriverSchema[] = [];
    try {
      drivers = await deps.loadDrivers();
    } catch (err) {
      deps.log(`[schemas] driver schemas unavailable, serving static schemas: ${String(err)}`);
    }
    if (drivers.length > 0) {
      deps.log(`[schemas] generated schemas for ${drivers.length} installed drivers`);
    }

    return new Map<SchemaKind, string>([
      [
        "client-config",
        JSON.stringify(
          withDriverAllowCompletions(client as Record<string, unknown>, drivers),
        ),
      ],
      [
        "exporter-config",
        JSON.stringify(withDriverCompletions(exporter as Record<string, unknown>, drivers)),
      ],
      ["user-config", JSON.stringify(user)],
    ]);
  };

  const schemas = (): Promise<Map<SchemaKind, string>> => (cached ??= buildSchemas());

  const requestSchema = (resource: string): string | undefined => {
    let fsPath: string;
    try {
      fsPath = vscode.Uri.parse(resource).fsPath;
    } catch {
      return undefined;
    }
    const kind = schemaKindForFile(deps.configHome, fsPath);
    return kind === undefined ? undefined : schemaUriForKind(kind, String(generation));
  };

  const requestSchemaContent = async (uri: string): Promise<string> => {
    const kind = schemaKindForUri(uri);
    if (kind === undefined) {
      throw new Error(`Unknown Jumpstarter schema URI: ${uri}`);
    }
    const built = await schemas();
    const content = built.get(kind);
    if (content === undefined) {
      throw new Error(`No content generated for Jumpstarter schema: ${kind}`);
    }
    return content;
  };

  const tryRegister = async (): Promise<void> => {
    if (registered) {
      return;
    }
    const extension = vscode.extensions.getExtension(YAML_EXTENSION_ID);
    if (extension === undefined) {
      return; // YAML extension not installed — degrade silently.
    }
    try {
      const api: unknown = extension.isActive ? extension.exports : await extension.activate();
      if (!isYamlExtensionApi(api)) {
        deps.log(
          "[schemas] YAML extension is present but does not expose registerContributor; skipping schema association.",
        );
        return;
      }
      registered = api.registerContributor(
        SCHEMA_URI_SCHEME,
        requestSchema,
        requestSchemaContent,
        "Jumpstarter",
      );
      if (registered) {
        deps.log("[schemas] Registered Jumpstarter YAML schema association.");
      }
    } catch (err) {
      deps.log(`[schemas] Failed to register YAML schema association: ${String(err)}`);
    }
  };

  void tryRegister();
  const extensionsListener = vscode.extensions.onDidChange(() => void tryRegister());
  const environmentListener = deps.onDidChangeEnvironment(() => {
    generation += 1;
    cached = undefined;
  });

  return vscode.Disposable.from(extensionsListener, environmentListener);
}
