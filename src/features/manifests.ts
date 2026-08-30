/**
 * Manifests feature — creating cluster resources from the editor.
 *
 * A wizard asks only for a resource's identity, writes a commented YAML draft
 * and opens it. Whatever the wizard cannot ask about — an exporter set's
 * template, a client's labels — is edited there, and nothing reaches the
 * cluster until "Apply to Cluster" runs `jmp admin apply` on the file.
 *
 * Also hosts importing: fetching the config the cluster issued for an existing
 * client or exporter (`jmp admin import`) and opening it for editing.
 *
 * Wire-up: registerManifests(context, services) from extension.ts.
 */

import * as vscode from "vscode";
import { AdminOptions, Services } from "../services";
import { AppliedResource } from "../types";
import { openConfigForEditing } from "./openConfig";
import { driverAllowEntries } from "./schemas/dynamic";
import {
  buildClientManifest,
  buildExporterManifest,
  buildExporterSetManifest,
  DraftKind,
  draftFileName,
  importableResources,
  looksLikeJumpstarterManifest,
  summarizeApplied,
  validateResourceName,
} from "./manifests/templates";

/** Where drafts are written; they are scratch files, not project files. */
const DRAFTS_DIR = "manifests";

// ---------------------------------------------------------------------------
// Importing an existing resource's config
// ---------------------------------------------------------------------------

/**
 * Fetch the config the cluster issued for a client or exporter and open it.
 *
 * The config carries a token: `jmp admin import` writes it straight to disk
 * and prints only the path, so the credential never passes through here.
 */
export async function importConfigFromCluster(
  services: Services,
  kind: "client" | "exporter",
  options: AdminOptions,
  name?: string,
): Promise<void> {
  let target = name;
  if (!target) {
    target = await pickResource(services, kind, options);
    if (!target) {
      return;
    }
  }

  const access = kind === "client" ? await pickDriverAccess(services) : {};
  if (!access) {
    return;
  }

  try {
    const path = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Importing ${kind} '${target}'…` },
      () => services.jmp.adminImportConfig(kind, target as string, options, access),
    );
    void vscode.window.showInformationMessage(
      `Jumpstarter: imported ${kind} '${target}' to ${path}.`,
    );
    await openConfigForEditing(services, path, `${kind} config '${target}'`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Jumpstarter: could not import ${kind}: ${message}`);
  }
}

/** QuickPick over the clients or exporters in the namespace. */
async function pickResource(
  services: Services,
  kind: "client" | "exporter",
  options: AdminOptions,
): Promise<string | undefined> {
  let items: { label: string; description?: string }[];
  try {
    items =
      kind === "client"
        ? (await services.jmp.adminClients(options)).map((client) => ({
            label: client.metadata.name,
            description: client.status?.endpoint,
          }))
        : (await services.jmp.adminExporters(options)).map((exporter) => ({
            label: exporter.metadata.name,
            description: Object.entries(exporter.metadata.labels ?? {})
              .map(([key, value]) => `${key}=${value}`)
              .join(" · "),
          }));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Jumpstarter: could not list ${kind}s: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      `Jumpstarter: no ${kind}s in namespace '${options.namespace ?? "default"}'.`,
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: `Import ${kind} config`,
    placeHolder: `${kind} to import from the cluster`,
  });
  return picked?.label;
}

/**
 * Which driver clients an imported client config may import.
 *
 * A client config that allows nothing cannot drive anything, so this is asked
 * rather than defaulted; the packages come from the drivers installed in the
 * active environment.
 */
async function pickDriverAccess(
  services: Services,
): Promise<{ allow?: string[]; unsafe?: boolean } | undefined> {
  const unsafeLabel = "$(unlock) Allow every driver package (unsafe)";
  const chooseLabel = "$(list-selection) Choose driver packages…";
  const noneLabel = "$(circle-slash) Allow none for now";
  const choice = await vscode.window.showQuickPick(
    [
      { label: chooseLabel, description: "pick from the drivers installed here" },
      { label: unsafeLabel, description: "any driver client the config asks for" },
      { label: noneLabel, description: "edit drivers.allow in the config later" },
    ],
    { title: "Driver access", placeHolder: "Which driver clients may this config load?" },
  );
  if (!choice) {
    return undefined;
  }
  if (choice.label === unsafeLabel) {
    return { unsafe: true };
  }
  if (choice.label === noneLabel) {
    return {};
  }

  let entries: { value: string; documentation: string }[] = [];
  try {
    entries = driverAllowEntries(await services.jmp.driverSchemas());
  } catch (err) {
    services.jmp.log(`[manifests] driver schema listing failed: ${String(err)}`);
  }
  if (entries.length === 0) {
    void vscode.window.showWarningMessage(
      "Jumpstarter: no drivers found in this environment; importing with no driver access.",
    );
    return {};
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({ label: entry.value, detail: entry.documentation })),
    { title: "Allowed driver clients", canPickMany: true },
  );
  if (!picked) {
    return undefined;
  }
  return { allow: picked.map((item) => item.label) };
}

// ---------------------------------------------------------------------------
// Drafting a new resource
// ---------------------------------------------------------------------------

/** Prompt for key=value labels, one at a time. Undefined on cancel. */
async function collectLabels(title: string): Promise<Record<string, string> | undefined> {
  const labels: Record<string, string> = {};
  for (;;) {
    const entered = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    const raw = await vscode.window.showInputBox({
      title,
      prompt: "Label as key=value; leave empty when done",
      placeHolder: entered.length > 0 ? `so far: ${entered}` : "board=rpi4",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 || /^[^=\s]+=[^=\s]*$/.test(value.trim())
          ? undefined
          : "Use key=value",
    });
    if (raw === undefined) {
      return undefined;
    }
    if (raw.trim().length === 0) {
      return labels;
    }
    const [key, value] = raw.trim().split("=");
    labels[key] = value;
  }
}

async function draftNewResource(
  context: vscode.ExtensionContext,
  services: Services,
  kind: DraftKind,
  options: AdminOptions,
  drafts: Set<string>,
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: `New ${kind}`,
    prompt: `Name for the new ${kind.toLowerCase()} in the cluster`,
    ignoreFocusOut: true,
    validateInput: validateResourceName,
  });
  if (!name) {
    return;
  }

  const namespace = await vscode.window.showInputBox({
    title: `New ${kind}`,
    prompt: "Namespace to create it in",
    value: options.namespace ?? "default",
    ignoreFocusOut: true,
    validateInput: validateResourceName,
  });
  if (!namespace) {
    return;
  }

  const labels = await collectLabels(`New ${kind} — labels`);
  if (labels === undefined) {
    return;
  }
  const identity = { name: name.trim(), namespace: namespace.trim(), labels };

  let content: string;
  if (kind === "Client") {
    content = buildClientManifest(identity);
  } else if (kind === "Exporter") {
    content = buildExporterManifest(identity);
  } else {
    const className = await vscode.window.showInputBox({
      title: "New ExporterSet",
      prompt: "VirtualTargetClass that provisions the members",
      placeHolder: "qemu",
      ignoreFocusOut: true,
      validateInput: validateResourceName,
    });
    if (!className) {
      return;
    }
    content = buildExporterSetManifest({
      ...identity,
      className: className.trim(),
      minReplicas: 0,
      maxReplicas: 2,
      minAvailableReplicas: 1,
    });
  }

  const uri = vscode.Uri.joinPath(
    context.globalStorageUri,
    DRAFTS_DIR,
    draftFileName(kind, identity.name),
  );
  try {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(context.globalStorageUri, DRAFTS_DIR),
    );
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Jumpstarter: could not write the draft: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  drafts.add(uri.fsPath);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  services.jmp.log(`[manifests] drafted ${kind} '${identity.name}' at ${uri.fsPath}`);
  void vscode.window.showInformationMessage(
    `Review the ${kind.toLowerCase()}, then apply it to the cluster.`,
    "Apply to Cluster",
  ).then((choice) => {
    if (choice === "Apply to Cluster") {
      void vscode.commands.executeCommand("jumpstarter.applyManifest", uri);
    }
  });
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

async function applyDocument(
  services: Services,
  options: AdminOptions,
  uri: vscode.Uri | undefined,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  const document = uri
    ? await vscode.workspace.openTextDocument(uri)
    : vscode.window.activeTextEditor?.document;
  if (!document) {
    void vscode.window.showInformationMessage("Jumpstarter: open a manifest to apply first.");
    return;
  }
  if (!looksLikeJumpstarterManifest(document.getText())) {
    void vscode.window.showWarningMessage(
      "Jumpstarter: this file has no Jumpstarter resources in it (expected apiVersion: jumpstarter.dev/...).",
    );
    return;
  }
  // The CLI reads the file, so unsaved edits would silently not be applied.
  if (document.isDirty && !(await document.save())) {
    void vscode.window.showErrorMessage("Jumpstarter: could not save the manifest before applying.");
    return;
  }

  const verb = opts.dryRun ? "Validating" : "Applying";
  try {
    const applied = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${verb} manifest…` },
      () => services.jmp.adminApply([document.uri.fsPath], options, opts),
    );
    await reportApplied(services, options, applied, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Jumpstarter: apply failed: ${message}`);
  }
}

async function reportApplied(
  services: Services,
  options: AdminOptions,
  applied: readonly AppliedResource[],
  opts: { dryRun?: boolean },
): Promise<void> {
  const summary = summarizeApplied(applied);
  if (opts.dryRun) {
    void vscode.window.showInformationMessage(`Jumpstarter: manifest is valid (${summary}).`);
    return;
  }

  services.notifyLeasesChanged();
  await vscode.commands.executeCommand("jumpstarter.admin.refresh");

  // A client or exporter is only usable once its generated credentials are on
  // this machine, so offer that as the next step rather than leaving it.
  const importable = importableResources(applied);
  if (importable.length === 0) {
    void vscode.window.showInformationMessage(`Jumpstarter: ${summary}.`);
    return;
  }
  const first = importable[0];
  const action = `Import ${first.kind} config`;
  const choice = await vscode.window.showInformationMessage(`Jumpstarter: ${summary}.`, action);
  if (choice === action) {
    await importConfigFromCluster(services, first.kind, options, first.name);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerManifests(
  context: vscode.ExtensionContext,
  services: Services,
  resolveOptions: () => Promise<AdminOptions>,
): void {
  /** Drafts written this session, so their editors get the apply button. */
  const drafts = new Set<string>();

  const updateContext = async (editor?: vscode.TextEditor): Promise<void> => {
    const document = editor?.document;
    const applicable =
      document !== undefined &&
      (drafts.has(document.uri.fsPath) ||
        (document.languageId === "yaml" && looksLikeJumpstarterManifest(document.getText())));
    await vscode.commands.executeCommand(
      "setContext",
      "jumpstarter.canApplyManifest",
      applicable,
    );
  };
  void updateContext(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => void updateContext(editor)),
    vscode.workspace.onDidSaveTextDocument(
      () => void updateContext(vscode.window.activeTextEditor),
    ),

    vscode.commands.registerCommand("jumpstarter.admin.newResource", async () => {
      // `kind` is taken by QuickPickItem itself, hence `draft`.
      const kinds: { label: string; draft: DraftKind; description: string }[] = [
        {
          label: "$(account) Client",
          draft: "Client",
          description: "an identity that leases exporters",
        },
        {
          label: "$(server) Exporter",
          draft: "Exporter",
          description: "a machine that exports hardware",
        },
        {
          label: "$(layers) Exporter Set",
          draft: "ExporterSet",
          description: "a pool provisioned on demand",
        },
      ];
      const picked = await vscode.window.showQuickPick(kinds, {
        title: "New cluster resource",
        placeHolder: "What to create in the cluster",
      });
      if (!picked) {
        return;
      }
      await draftNewResource(context, services, picked.draft, await resolveOptions(), drafts);
    }),

    vscode.commands.registerCommand("jumpstarter.applyManifest", async (uri?: vscode.Uri) => {
      await applyDocument(services, await resolveOptions(), uri);
    }),

    vscode.commands.registerCommand("jumpstarter.validateManifest", async (uri?: vscode.Uri) => {
      await applyDocument(services, await resolveOptions(), uri, { dryRun: true });
    }),

    // Palette entry points that do their own picking.
    vscode.commands.registerCommand("jumpstarter.importClientConfig", async () => {
      await importConfigFromCluster(services, "client", await resolveOptions());
    }),

    vscode.commands.registerCommand("jumpstarter.importExporterConfig", async () => {
      await importConfigFromCluster(services, "exporter", await resolveOptions());
    }),
  );
}
