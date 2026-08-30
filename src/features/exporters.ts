/**
 * Exporters feature — tree view `jumpstarter.exporters`.
 *
 * Shows the exporters visible to the ACTIVE client (with lease/online/status
 * columns), themed status icons, label descriptions and markdown tooltips.
 * Actions: acquire a lease on an AVAILABLE exporter (duration QuickPick),
 * lease by label selector (multi-step key/value builder with autocomplete
 * from the fetched label sets) and a selector filter on the view.
 *
 * Wire-up: registerExporters(context, services) from extension.ts.
 */

import * as vscode from "vscode";
import { JmpError, Services, Poller } from "../services";
import { Exporter } from "../types";
import {
  buildExporterItemSpec,
  buildSelector,
  collectLabelKeys,
  collectLabelValues,
  DURATION_PRESETS,
  filterExportersBySelector,
  isValidDuration,
  parseSelector,
  SelectorPair,
  sortExporters,
} from "./exporters/model";

// ---------------------------------------------------------------------------
// Tree nodes
// ---------------------------------------------------------------------------

interface ExporterNode {
  kind: "exporter";
  exporter: Exporter;
}

interface MessageNode {
  kind: "message";
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  command?: vscode.Command;
}

type ExportersNode = ExporterNode | MessageNode;

type ViewState =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "no-client" }
  | { kind: "auth-expired"; client: string }
  | { kind: "error"; message: string }
  | { kind: "data"; client: string; exporters: Exporter[] };

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

class ExportersTreeProvider implements vscode.TreeDataProvider<ExportersNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this.changeEmitter.event;

  private state: ViewState = { kind: "loading" };
  private filterPairs: SelectorPair[] = [];
  private filterRaw = "";
  private tickSeq = 0;
  /** Set by register(); stopped when a tick hits an expired token. */
  poller: Poller | undefined;

  constructor(private readonly services: Services) {}

  // ----- state accessors used by the commands ------------------------------

  /** Alias of the client whose data is on screen, or null. */
  get activeClient(): string | null {
    return this.state.kind === "data" || this.state.kind === "auth-expired"
      ? this.state.client
      : null;
  }

  /** Last fetched exporters (unfiltered); [] before the first load. */
  get exporters(): readonly Exporter[] {
    return this.state.kind === "data" ? this.state.exporters : [];
  }

  get filter(): string {
    return this.filterRaw;
  }

  setFilter(raw: string, pairs: SelectorPair[]): void {
    this.filterRaw = raw;
    this.filterPairs = pairs;
    this.changeEmitter.fire();
  }

  // ----- polling tick ------------------------------------------------------

  /**
   * One refresh pass. Errors are handled here (rendered into the view) so
   * the poller's onTickError never sees them; an expired token additionally
   * stops the poller until an external event restarts it.
   */
  async tick(): Promise<void> {
    const seq = ++this.tickSeq;
    const apply = (state: ViewState): void => {
      if (seq === this.tickSeq) {
        this.state = state;
        this.changeEmitter.fire();
      }
    };

    const availability = this.services.jmp.getAvailability();
    if (availability && availability.kind !== "ok") {
      const message =
        availability.kind === "no-python"
          ? "No active Python interpreter"
          : availability.kind === "no-jmp-in-env"
            ? "jmp not found in the active Python environment"
            : `jmp is not working: ${availability.error.message}`;
      apply({ kind: "unavailable", message });
      return;
    }

    let client: string | null = null;
    try {
      const clients = await this.services.jmp.listClients();
      client = clients.currentConfig;
      if (!client) {
        apply({ kind: "no-client" });
        return;
      }
      await this.services.jmp.ensureAuthValid(client);
      const exporters = await this.services.jmp.getExporters(client);
      apply({ kind: "data", client, exporters: sortExporters(exporters) });
    } catch (err) {
      if (err instanceof JmpError && err.kind === "auth-expired" && client) {
        apply({ kind: "auth-expired", client });
        // Never keep polling a client with an expired token — a remote call
        // would start an interactive browser re-auth and hang.
        this.poller?.stop();
        return;
      }
      const message =
        err instanceof JmpError && err.kind === "connection-failed"
          ? `Controller unreachable: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      apply({ kind: "error", message });
    }
  }

  // ----- TreeDataProvider --------------------------------------------------

  getChildren(element?: ExportersNode): ExportersNode[] {
    if (element) {
      return [];
    }
    switch (this.state.kind) {
      case "loading":
        return [{ kind: "message", label: "Loading exporters…", iconId: "loading~spin" }];
      case "unavailable":
        return [{ kind: "message", label: this.state.message, iconId: "warning" }];
      case "no-client":
        return [
          {
            kind: "message",
            label: "No Jumpstarter client selected",
            tooltip: "Select a client in the Clients view or run `jmp config client use <alias>`.",
            iconId: "info",
          },
        ];
      case "auth-expired":
        return [
          {
            kind: "message",
            label: `Re-authenticate client '${this.state.client}'`,
            description: "token expired",
            tooltip: "The token for this client is expired or missing. Click to re-authenticate.",
            iconId: "key",
            command: {
              command: "jumpstarter.exporters.reauthenticate",
              title: "Re-authenticate",
              arguments: [this.state.client],
            },
          },
        ];
      case "error":
        return [
          {
            kind: "message",
            label: this.state.message,
            iconId: "error",
            command: { command: "jumpstarter.exporters.refresh", title: "Refresh" },
          },
        ];
      case "data": {
        const filtered = filterExportersBySelector(this.state.exporters, this.filterPairs);
        if (filtered.length === 0) {
          const label =
            this.state.exporters.length === 0
              ? "No exporters visible to this client"
              : `No exporters match filter '${this.filterRaw}'`;
          return [{ kind: "message", label, iconId: "info" }];
        }
        return filtered.map((exporter) => ({ kind: "exporter", exporter }));
      }
    }
  }

  getTreeItem(node: ExportersNode): vscode.TreeItem {
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.contextValue = "exporter-message";
      if (node.iconId) {
        item.iconPath = new vscode.ThemeIcon(node.iconId);
      }
      item.command = node.command;
      return item;
    }
    const spec = buildExporterItemSpec(node.exporter);
    const item = new vscode.TreeItem(spec.label, vscode.TreeItemCollapsibleState.None);
    item.id = spec.id;
    item.description = spec.description;
    const tooltip = new vscode.MarkdownString(spec.tooltipMarkdown);
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.contextValue = spec.contextValue;
    item.iconPath = new vscode.ThemeIcon(
      spec.icon.id,
      spec.icon.colorId ? new vscode.ThemeColor(spec.icon.colorId) : undefined,
    );
    return item;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Interactive helpers
// ---------------------------------------------------------------------------

/** Duration QuickPick: presets + custom input. Undefined on cancel. */
async function pickDuration(): Promise<string | undefined> {
  const custom = "$(edit) Custom…";
  const picked = await vscode.window.showQuickPick(
    [...DURATION_PRESETS.map((d) => ({ label: d })), { label: custom }],
    { placeHolder: "Lease duration" },
  );
  if (!picked) {
    return undefined;
  }
  if (picked.label !== custom) {
    return picked.label;
  }
  return vscode.window.showInputBox({
    prompt: "Lease duration (e.g. 30m, 1h, 1h30m)",
    validateInput: (v) => (isValidDuration(v) ? undefined : "Use forms like 30m, 1h, 1h30m"),
  });
}

/**
 * Multi-step selector builder: pick key → pick value → add another / done,
 * with autocomplete built from the label sets of the already-fetched
 * exporters. Returns the pairs, or undefined on cancel.
 */
async function buildSelectorInteractively(
  exporters: readonly Exporter[],
): Promise<SelectorPair[] | undefined> {
  const pairs: SelectorPair[] = [];
  const customEntry = "$(edit) Enter custom…";
  for (;;) {
    const step = `Selector: ${pairs.length > 0 ? buildSelector(pairs) : "(empty)"}`;

    // --- pick a key ---
    const usedKeys = new Set(pairs.map((p) => p.key));
    const keyItems = collectLabelKeys(exporters)
      .filter((k) => !usedKeys.has(k))
      .map((k) => ({ label: k }));
    const keyPick = await vscode.window.showQuickPick([...keyItems, { label: customEntry }], {
      placeHolder: `${step} — pick a label key`,
    });
    if (!keyPick) {
      return undefined;
    }
    let key = keyPick.label;
    if (key === customEntry) {
      const typed = await vscode.window.showInputBox({
        prompt: "Label key",
        validateInput: (v) =>
          /^[^=,\s]+$/.test(v.trim()) ? undefined : "Key must not contain '=', ',' or spaces",
      });
      if (!typed) {
        return undefined;
      }
      key = typed.trim();
    }

    // --- pick a value ---
    const valueItems = collectLabelValues(exporters, key).map((v) => ({ label: v }));
    const valuePick = await vscode.window.showQuickPick([...valueItems, { label: customEntry }], {
      placeHolder: `${step} — pick a value for '${key}'`,
    });
    if (!valuePick) {
      return undefined;
    }
    let value = valuePick.label;
    if (value === customEntry) {
      const typed = await vscode.window.showInputBox({
        prompt: `Value for label '${key}'`,
        validateInput: (v) =>
          /^[^=,\s]+$/.test(v.trim()) ? undefined : "Value must not contain '=', ',' or spaces",
      });
      if (!typed) {
        return undefined;
      }
      value = typed.trim();
    }
    pairs.push({ key, value });

    // --- add another or finish ---
    const matches = filterExportersBySelector(exporters, pairs).length;
    const done = `$(check) Done — lease with '${buildSelector(pairs)}'`;
    const addAnother = "$(add) Add another label";
    const next = await vscode.window.showQuickPick(
      [
        { label: done, description: `${matches} exporter(s) match` },
        { label: addAnother },
      ],
      { placeHolder: `Selector: ${buildSelector(pairs)}` },
    );
    if (!next) {
      return undefined;
    }
    if (next.label === done) {
      return pairs;
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerExporters(context: vscode.ExtensionContext, services: Services): void {
  const provider = new ExportersTreeProvider(services);
  context.subscriptions.push(provider);

  const treeView = vscode.window.createTreeView("jumpstarter.exporters", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  const poller = services.createPoller({
    name: "exporters",
    tick: () => provider.tick(),
  });
  provider.poller = poller;
  context.subscriptions.push(poller);
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => poller.setVisible(e.visible)),
  );
  poller.setVisible(treeView.visible);
  poller.start();

  // External changes (login/`jmp config client use` in a terminal, interpreter
  // switch) restart polling — including after an auth-expired stop.
  context.subscriptions.push(
    services.configWatcher.onDidChangeConfig(() => {
      poller.start();
      void poller.refreshNow();
    }),
    services.jmp.onDidChangeAvailability(() => {
      poller.start();
      void poller.refreshNow();
    }),
  );

  /** Resolve the client to act on, preferring what's already on screen. */
  const requireClient = async (): Promise<string | undefined> => {
    if (provider.activeClient) {
      return provider.activeClient;
    }
    try {
      const clients = await services.jmp.listClients();
      if (clients.currentConfig) {
        return clients.currentConfig;
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Jumpstarter: could not list clients: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    void vscode.window.showWarningMessage(
      "Jumpstarter: no client selected. Choose one in the Clients view first.",
    );
    return undefined;
  };

  /** Guard user-initiated remote calls against the interactive re-auth hang. */
  const checkAuth = async (client: string): Promise<boolean> => {
    try {
      await services.jmp.ensureAuthValid(client);
      return true;
    } catch (err) {
      if (err instanceof JmpError && err.kind === "auth-expired") {
        void vscode.window.showWarningMessage(
          `Jumpstarter: client '${client}' needs re-authentication before creating a lease.`,
        );
        return false;
      }
      throw err;
    }
  };

  const createLease = async (
    client: string,
    opts: { exporterName?: string; selector?: string },
    duration: string,
  ): Promise<void> => {
    const target = opts.exporterName ?? `selector '${opts.selector}'`;
    try {
      const leaseName = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Jumpstarter: acquiring lease on ${target}…`,
        },
        () => services.jmp.createLease(client, { ...opts, duration }),
      );
      void vscode.window.showInformationMessage(
        `Jumpstarter: lease '${leaseName}' created on ${target}.`,
      );
      void poller.refreshNow();
      // Nudge the (sibling-owned) Leases view when present — best effort.
      const commands = new Set(await vscode.commands.getCommands(true));
      if (commands.has("jumpstarter.leases.refresh")) {
        void vscode.commands.executeCommand("jumpstarter.leases.refresh");
      }
      if (commands.has("jumpstarter.leases.focus")) {
        void vscode.commands.executeCommand("jumpstarter.leases.focus");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Jumpstarter: failed to create lease: ${message}`);
    }
  };

  context.subscriptions.push(
    // View-title refresh button.
    vscode.commands.registerCommand("jumpstarter.exporters.refresh", () => {
      poller.start();
      return poller.refreshNow();
    }),

    // Inline "Acquire lease" on AVAILABLE rows (also works from the context
    // menu; without a node it offers a picker over available exporters).
    vscode.commands.registerCommand(
      "jumpstarter.exporters.acquireLease",
      async (node?: ExportersNode) => {
        let exporterName: string | undefined;
        if (node && node.kind === "exporter") {
          exporterName = node.exporter.name;
        } else {
          const available = provider.exporters.filter(
            (e) => e.status === "AVAILABLE" && e.online,
          );
          if (available.length === 0) {
            void vscode.window.showInformationMessage(
              "Jumpstarter: no available exporters to lease.",
            );
            return;
          }
          const pick = await vscode.window.showQuickPick(
            available.map((e) => ({ label: e.name, description: e.namespace })),
            { placeHolder: "Exporter to lease" },
          );
          if (!pick) {
            return;
          }
          exporterName = pick.label;
        }
        const client = await requireClient();
        if (!client) {
          return;
        }
        const duration = await pickDuration();
        if (!duration) {
          return;
        }
        if (!(await checkAuth(client))) {
          return;
        }
        await createLease(client, { exporterName }, duration);
      },
    ),

    // Lease by label selector (palette + view title).
    vscode.commands.registerCommand("jumpstarter.leaseBySelector", async () => {
      const client = await requireClient();
      if (!client) {
        return;
      }
      const pairs = await buildSelectorInteractively(provider.exporters);
      if (!pairs || pairs.length === 0) {
        return;
      }
      const duration = await pickDuration();
      if (!duration) {
        return;
      }
      if (!(await checkAuth(client))) {
        return;
      }
      await createLease(client, { selector: buildSelector(pairs) }, duration);
    }),

    // Selector filter on the view (view-title button).
    vscode.commands.registerCommand("jumpstarter.exporters.filter", async () => {
      const raw = await vscode.window.showInputBox({
        prompt: "Filter exporters by label selector (k=v,k2=v2). Leave empty to clear.",
        value: provider.filter,
        validateInput: (v) =>
          parseSelector(v) === null ? "Use key=value pairs separated by commas" : undefined,
      });
      if (raw === undefined) {
        return;
      }
      const pairs = parseSelector(raw) ?? [];
      provider.setFilter(pairs.length > 0 ? raw.trim() : "", pairs);
      treeView.description = pairs.length > 0 ? `filter: ${raw.trim()}` : undefined;
    }),

    // Internal: clicked from the auth-expired message row. Delegates to the
    // auth feature's login command when registered, otherwise points at the
    // terminal flow. Not contributed to any menu.
    vscode.commands.registerCommand(
      "jumpstarter.exporters.reauthenticate",
      async (client?: string) => {
        const commands = new Set(await vscode.commands.getCommands(true));
        for (const id of [
          "jumpstarter.reauthenticateClient",
          "jumpstarter.login",
          "jumpstarter.auth.login",
        ]) {
          if (commands.has(id)) {
            await vscode.commands.executeCommand(id, client);
            return;
          }
        }
        void vscode.window.showInformationMessage(
          `Jumpstarter: run 'jmp login${client ? ` --client ${client}` : ""}' in a terminal to re-authenticate, then refresh.`,
        );
      },
    ),
  );
}
