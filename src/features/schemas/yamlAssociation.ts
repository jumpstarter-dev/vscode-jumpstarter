/**
 * Binds the bundled JSON schemas to Jumpstarter YAML config files via the
 * Red Hat YAML extension's schema-contributor API.
 *
 * If the YAML extension (redhat.vscode-yaml) is not installed the feature
 * degrades silently; if it gets installed later (extensions change event)
 * the contributor is registered then.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import {
  SchemaKind,
  schemaFileName,
  schemaKindForFile,
  schemaKindForUri,
  schemaUriForKind,
} from "./logic";

const YAML_EXTENSION_ID = "redhat.vscode-yaml";
const CONTRIBUTOR_NAME = "jumpstarter";

/** The (undocumented-but-stable) API exported by redhat.vscode-yaml. */
interface YamlExtensionApi {
  registerContributor(
    schema: string,
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
  /** Log channel for non-fatal diagnostics. */
  output: vscode.OutputChannel;
}

/**
 * Register the schema contributor with the YAML extension when present.
 * Returns a Disposable that stops the late-install listener (an already
 * registered contributor cannot be unregistered — that is fine, the callbacks
 * become inert on dispose of the extension host).
 */
export function activateYamlAssociation(deps: YamlAssociationDeps): vscode.Disposable {
  let registered = false;
  const schemaCache = new Map<SchemaKind, string>();

  const requestSchema = (resource: string): string | undefined => {
    let fsPath: string;
    try {
      fsPath = vscode.Uri.parse(resource).fsPath;
    } catch {
      return undefined;
    }
    const kind = schemaKindForFile(deps.configHome, fsPath);
    return kind === undefined ? undefined : schemaUriForKind(kind);
  };

  const requestSchemaContent = async (uri: string): Promise<string> => {
    const kind = schemaKindForUri(uri);
    if (kind === undefined) {
      throw new Error(`Unknown Jumpstarter schema URI: ${uri}`);
    }
    const cached = schemaCache.get(kind);
    if (cached !== undefined) {
      return cached;
    }
    const content = await fs.readFile(deps.schemaPath(schemaFileName(kind)), "utf8");
    schemaCache.set(kind, content);
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
        deps.output.appendLine(
          "[schemas] YAML extension is present but does not expose registerContributor; skipping schema association.",
        );
        return;
      }
      registered = api.registerContributor(CONTRIBUTOR_NAME, requestSchema, requestSchemaContent, "Jumpstarter");
      if (registered) {
        deps.output.appendLine("[schemas] Registered Jumpstarter YAML schema association.");
      }
    } catch (err) {
      deps.output.appendLine(`[schemas] Failed to register YAML schema association: ${String(err)}`);
    }
  };

  void tryRegister();
  const listener = vscode.extensions.onDidChange(() => void tryRegister());
  return listener;
}
