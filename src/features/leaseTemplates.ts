/**
 * Lease Templates feature: view id jumpstarter.leaseTemplates.
 *
 * - Lists the lease templates the active client can request
 *   (`jmp get lease-templates`): the sets of exporters a lab administrator
 *   published, each with its roles, how many can be leased now, its forwards
 *   and its documentation.
 * - "Lease This Template…" requests one (`jmp create lease -t NAME`), after
 *   asking which optional roles to leave out and for how long. The lease it
 *   makes holds an exporter for each role and shows up in the Leases view.
 * - A `jmp` from before lease templates, or a controller too old for them,
 *   is not an error: the view is hidden (context key
 *   `jumpstarter.leaseTemplatesAvailable`) and the reason is logged, and
 *   given when the user asks to lease from a template.
 */

import * as vscode from "vscode";
import { Services, JmpError } from "../services";
import { LeaseTemplate } from "../types";
import { showDetails } from "./details";
import { isValidDuration } from "./leases/model";
import * as model from "./leaseTemplates/model";
import { LeaseTemplatesTreeProvider, TemplateDocNode, TemplateNode } from "./leaseTemplates/provider";

const AVAILABLE_CONTEXT = "jumpstarter.leaseTemplatesAvailable";

export function registerLeaseTemplates(
  context: vscode.ExtensionContext,
  services: Services,
): LeaseTemplatesTreeProvider {
  const { jmp } = services;
  const provider = new LeaseTemplatesTreeProvider();
  context.subscriptions.push(provider);

  const treeView = vscode.window.createTreeView("jumpstarter.leaseTemplates", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => {
      const selected = e.selection[0] as { template?: LeaseTemplate } | undefined;
      if (selected?.template) {
        showDetails({ kind: "leaseTemplate", template: selected.template });
      }
    }),
  );

  let lastClient: string | null = null;
  /** The reason last logged, so the same hint is not logged at every refresh. */
  let logged: string | undefined;

  const setAvailable = (available: boolean): void => {
    void vscode.commands.executeCommand("setContext", AVAILABLE_CONTEXT, available);
  };

  const poller = services.createPoller({
    name: "lease templates",
    tick: async () => {
      const clients = await jmp.listClients();
      const current = clients.currentConfig;
      if (!current) {
        lastClient = null;
        provider.setNoClient();
        treeView.description = "";
        return;
      }
      lastClient = current;
      // Never let a background call hit an expired token (it would start an
      // interactive browser re-auth and hang).
      await jmp.ensureAuthValid(current);
      const result = await jmp.getLeaseTemplates(current);
      treeView.message = undefined;
      if (result.kind === "unavailable") {
        provider.setUnavailable(result.reason);
        setAvailable(false);
        if (logged !== result.reason) {
          logged = result.reason;
          jmp.log(`[lease templates] ${result.reason}`);
        }
        return;
      }
      logged = undefined;
      provider.setTemplates(current, result.templates);
      treeView.description = current;
      setAvailable(true);
    },
  });
  context.subscriptions.push(poller);

  context.subscriptions.push(
    poller.onTickError((err) => {
      if (err instanceof JmpError && err.kind === "auth-expired") {
        provider.setAuthExpired(lastClient ?? "current");
        treeView.message = undefined;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (!provider.setError(message)) {
        treeView.message = `Last refresh failed: ${message}`;
      }
      jmp.log(`[lease templates] refresh failed: ${message}`);
    }),
    treeView.onDidChangeVisibility((e) => poller.setVisible(e.visible)),
    // The view is hidden until the CLI is known to have templates, so nothing
    // would ever show it: these read once whether or not it is visible.
    services.configWatcher.onDidChangeConfig(() => void poller.refreshNow()),
    jmp.onDidChangeAvailability(() => void poller.refreshNow()),
    // A lease from a template takes exporters: the numbers that can be leased changed.
    services.onDidChangeLeases(() => {
      if (treeView.visible) {
        void poller.refreshNow();
      }
    }),
  );

  poller.start();

  // -- requesting a template ------------------------------------------------

  /** Which optional roles to leave out. Undefined when the user cancels; none when the template has none. */
  const askWithout = async (template: LeaseTemplate): Promise<string[] | undefined> => {
    const optional = model.optionalRoles(template);
    if (optional.length === 0) {
      return [];
    }
    const picked = await vscode.window.showQuickPick(
      optional.map((entry) => ({
        label: entry.member.name,
        description: [model.memberSelection(entry), `${entry.available} available`]
          .filter((part) => part.length > 0)
          .join(" · "),
      })),
      {
        title: `Lease ${template.name}: optional roles to leave out`,
        placeHolder: "Select the roles to leave out, or press Enter to lease them all",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    return picked?.map((item) => item.label);
  };

  /** How long to lease for: `{}` is the template's default. Undefined when the user cancels. */
  const askDuration = async (template: LeaseTemplate): Promise<{ duration?: string } | undefined> => {
    const picked = await vscode.window.showQuickPick(model.durationChoices(template), {
      title: `Lease ${template.name}: duration`,
      placeHolder: "How long to hold the lease",
      ignoreFocusOut: true,
    });
    if (!picked) {
      return undefined;
    }
    if (!picked.custom) {
      return picked.duration ? { duration: picked.duration } : {};
    }
    const input = await vscode.window.showInputBox({
      title: "Custom lease duration",
      placeHolder: "e.g. 45m, 1h30m, 2h",
      ignoreFocusOut: true,
      validateInput: (value) => (isValidDuration(value) ? undefined : "Use a duration like 30m, 1h or 1h30m"),
    });
    return input ? { duration: input.trim() } : undefined;
  };

  const leaseTemplate = async (client: string, template: LeaseTemplate): Promise<void> => {
    const without = await askWithout(template);
    if (without === undefined) {
      return;
    }
    const duration = await askDuration(template);
    if (duration === undefined) {
      return;
    }
    try {
      await jmp.ensureAuthValid(client);
    } catch (err) {
      void vscode.window.showWarningMessage(
        err instanceof JmpError && err.kind === "auth-expired"
          ? `Jumpstarter: client '${client}' needs re-authentication first (re-authenticate from the Clients view or run \`jmp login\` in a terminal).`
          : `Jumpstarter: failed to check authentication: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const label = model.requestLabel(template.name, without);
    // Shown in the lease views for as long as it is outstanding: every role
    // has to be bound before the lease exists for a listing.
    const pending = services.pendingLeases.begin(client, label);
    try {
      const leaseName = await vscode.window.withProgress(
        { location: { viewId: "jumpstarter.leases" }, title: `Acquiring lease from template ${label}…` },
        () => jmp.createTemplateLease(client, { template: template.name, without, ...duration }),
      );
      void vscode.window.showInformationMessage(
        `Jumpstarter: lease '${leaseName}' created from template ${label}.`,
      );
      services.notifyLeasesChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Jumpstarter: failed to lease template ${template.name}: ${message}`);
    } finally {
      services.pendingLeases.end(pending);
    }
  };

  /** The templates to choose from, read now when the view has none yet. Undefined when there are none to offer. */
  const pickTemplate = async (): Promise<TemplateNode | undefined> => {
    if (provider.templates.length === 0 && provider.unavailableReason === undefined) {
      await poller.refreshNow();
    }
    if (provider.unavailableReason !== undefined) {
      void vscode.window.showInformationMessage(`Jumpstarter: ${provider.unavailableReason}`);
      return undefined;
    }
    const client = provider.client;
    if (!client || provider.templates.length === 0) {
      void vscode.window.showInformationMessage(
        client
          ? `Jumpstarter: client '${client}' has no lease templates to request.`
          : "Jumpstarter: select a client first; its lease templates are listed in the Lease Templates view.",
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      model.sortTemplates(provider.templates).map((template) => ({
        label: template.name,
        description: `${model.describeMembers(template)} · ${model.availableSummary(template)} available`,
        detail: template.description || undefined,
        template,
      })),
      { title: "Lease from a template", placeHolder: "Which lease template?", matchOnDescription: true },
    );
    return picked ? { kind: "template", client, template: picked.template } : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("jumpstarter.leaseTemplates.refresh", () => {
      jmp.forgetSharedReads(); // asked for by hand: read everything again
      poller.start();
      return poller.refreshNow();
    }),

    // From a template's row ("Lease This Template…"), or after choosing one ("Lease from Template…", in the
    // palette and beside the other lease commands of the Leases view).
    ...["jumpstarter.leaseTemplates.lease", "jumpstarter.leaseFromTemplate"].map((command) =>
      vscode.commands.registerCommand(command, async (node?: unknown) => {
        const given = node as TemplateNode | undefined;
        const target = given?.kind === "template" && given.template ? given : await pickTemplate();
        if (target) {
          await leaseTemplate(target.client, target.template);
        }
      }),
    ),

    vscode.commands.registerCommand("jumpstarter.leaseTemplates.openDoc", async (node?: unknown) => {
      const doc = node as TemplateDocNode | undefined;
      // Only what the view itself offered: a web address of the template's documentation.
      if (doc?.kind !== "doc" || !model.docLinks(doc.template).includes(doc.link)) {
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(doc.link, true));
    }),
  );

  return provider;
}
