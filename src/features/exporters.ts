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
import { Exporter, ExporterConfigRef } from "../types";
import { isValidAddress, redactSecretArgs, shellQuote } from "../services/jmpProtocol";
import { showDetails } from "./details";
import { acquireLease } from "./leases/acquire";
import { resolveIcon } from "./icons";
import { openConfigForEditing } from "./openConfig";
import {
  buildExporterItemSpec,
  exporterSetDescription,
  exporterSetSelector,
  exporterSetTooltip,
  ExporterSetGroup,
  groupExporterSets,
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

/**
 * Colour of the local-development beaker.
 *
 * Not charts.orange: several themes define that with an alpha (0.33 in Dark
 * Modern), which composites against the sidebar into a nearly black brown.
 * charts.yellow is opaque everywhere, stays in the palette the other rows use,
 * and reads as its own category next to the green and blue of the cluster.
 */
const LOCAL_ICON_COLOR = "charts.yellow";

interface ExporterNode {
  kind: "exporter";
  exporter: Exporter;
  /** Path of the local exporter YAML, when this exporter is configured here. */
  configPath?: string;
}

interface ExporterSetNode {
  kind: "exporterSet";
  group: ExporterSetGroup;
}

/**
 * An exporter configured on this machine that the controller does not show.
 *
 * These are development exporters: `jmp shell --exporter <alias>` serves the
 * config locally and opens a session against it, with no controller, no lease
 * and no registration.
 */
interface LocalExporterNode {
  kind: "localExporter";
  config: ExporterConfigRef;
}

/**
 * The section local exporters live under.
 *
 * They are a different kind of thing from everything above them — no
 * controller, no lease, no one else can see them — so they get their own
 * section rather than sitting among the cluster's exporters.
 */
interface LocalSectionNode {
  kind: "localSection";
  configs: ExporterConfigRef[];
  /** Open the section by default when there is nothing else in the view. */
  expanded: boolean;
}

interface MessageNode {
  kind: "message";
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  command?: vscode.Command;
}

type ExportersNode =
  | ExporterNode
  | ExporterSetNode
  | LocalSectionNode
  | LocalExporterNode
  | MessageNode;

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
  /** exporter name -> local exporter YAML path, refreshed on each tick. */
  private configPaths = new Map<string, string>();
  /** Every locally configured exporter, refreshed on each tick. */
  private localConfigs: ExporterConfigRef[] = [];
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
      // Local exporter YAMLs, so rows for exporters configured on this machine
      // can offer to open them. A failure here must not hide the exporters.
      try {
        const configs = await this.services.jmp.listExporterConfigs();
        this.localConfigs = configs;
        this.configPaths = new Map(configs.map((c) => [c.name, c.path]));
      } catch (err) {
        this.services.jmp.log(`[exporters] local config list failed: ${String(err)}`);
      }
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
      // A pool expands into its members, the local section into its configs;
      // nothing else has children.
      if (element.kind === "exporterSet") {
        return element.group.exporters.map((exporter) => this.exporterNode(exporter));
      }
      if (element.kind === "localSection") {
        return element.configs.map((config) => ({ kind: "localExporter", config }));
      }
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
        // The local section sits below whatever the cluster shows, including
        // when the cluster shows nothing: that is the case it exists for.
        const local = this.localSectionNode();
        if (filtered.length === 0) {
          const label =
            this.state.exporters.length === 0
              ? "No exporters visible to this client"
              : `No exporters match filter '${this.filterRaw}'`;
          return [{ kind: "message", label, iconId: "info" }, ...local];
        }
        const { sets, standalone } = groupExporterSets(filtered);
        return [
          ...sets.map((group): ExportersNode => ({ kind: "exporterSet", group })),
          ...standalone.map((exporter): ExportersNode => this.exporterNode(exporter)),
          ...local,
        ];
      }
    }
  }

  /**
   * The "Local Exporters" section, or nothing when there is none to show.
   *
   * A label filter is a question about the cluster, so the section is left out
   * while one is set rather than appearing to have passed it.
   */
  private localSectionNode(): ExportersNode[] {
    if (this.filterPairs.length > 0) {
      return [];
    }
    const configs = this.localOnlyConfigs();
    if (configs.length === 0) {
      return [];
    }
    return [{ kind: "localSection", configs, expanded: this.exporters.length === 0 }];
  }

  /**
   * Local configs the controller does not report — an exporter being written
   * or run outside a cluster. Ones the controller does show already appear as
   * their own row, with the same config reachable from the edit button.
   */
  private localOnlyConfigs(): ExporterConfigRef[] {
    const remote = new Set(this.exporters.map((exporter) => exporter.name));
    return this.localConfigs
      .filter((config) => !remote.has(config.name))
      .sort((a, b) => a.alias.localeCompare(b.alias));
  }

  /** One exporter row, carrying its local config path when it has one. */
  private exporterNode(exporter: Exporter): ExporterNode {
    return {
      kind: "exporter",
      exporter,
      configPath: this.configPaths.get(exporter.name),
    };
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
    if (node.kind === "exporterSet") {
      const group = node.group;
      const item = new vscode.TreeItem(
        group.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `exporterset/${group.name}`;
      item.description = exporterSetDescription(group);
      const tooltip = new vscode.MarkdownString(exporterSetTooltip(group));
      tooltip.supportThemeIcons = true;
      item.tooltip = tooltip;
      item.contextValue = "exporter-set";
      // Stacked layers: this row stands for several exporters.
      item.iconPath = new vscode.ThemeIcon("layers", new vscode.ThemeColor("charts.purple"));
      return item;
    }

    if (node.kind === "localSection") {
      const item = new vscode.TreeItem(
        "Local Exporters",
        node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = "local-exporters";
      item.description = `${node.configs.length} · not registered`;
      item.tooltip = new vscode.MarkdownString(
        [
          "**Local exporters**",
          "",
          "Exporter configs on this machine that the controller does not know about.",
          "",
          "They are served from here with `jmp shell --exporter <alias>`: no controller,",
          "no lease, and nobody else can reach them.",
        ].join("\n"),
      );
      item.contextValue = "exporter-local-section";
      item.iconPath = new vscode.ThemeIcon("beaker", new vscode.ThemeColor(LOCAL_ICON_COLOR));
      return item;
    }

    if (node.kind === "localExporter") {
      const item = new vscode.TreeItem(node.config.alias, vscode.TreeItemCollapsibleState.None);
      item.id = `local-exporter/${node.config.alias}`;
      // The section already says these are local; only the name the config
      // claims is worth repeating, and only when it differs from the alias.
      item.description =
        node.config.name !== node.config.alias ? node.config.name : undefined;
      item.tooltip = new vscode.MarkdownString(
        [
          `**${node.config.alias}**`,
          "",
          "Configured on this machine and not visible to the controller.",
          "",
          "Serve it locally with a shell session — no lease is involved.",
          "",
          `Config: \`${node.config.path}\``,
        ].join("\n"),
      );
      item.contextValue = "exporter-local";
      item.iconPath = new vscode.ThemeIcon("beaker", new vscode.ThemeColor(LOCAL_ICON_COLOR));
      return item;
    }

    const spec = buildExporterItemSpec(node.exporter);
    const item = new vscode.TreeItem(spec.label, vscode.TreeItemCollapsibleState.None);
    item.id = spec.id;
    item.description = spec.description;
    const tooltip = new vscode.MarkdownString(spec.tooltipMarkdown);
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    // "-local" marks rows whose exporter YAML lives on this machine, so the
    // edit action can be offered only where there is a file to open.
    item.contextValue = node.configPath ? `${spec.contextValue}-local` : spec.contextValue;
    item.iconPath = resolveIcon(spec.icon);
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
async function pickDuration(title?: string): Promise<string | undefined> {
  const custom = "$(edit) Custom…";
  const picked = await vscode.window.showQuickPick(
    [...DURATION_PRESETS.map((d) => ({ label: d })), { label: custom }],
    { title, placeHolder: "Lease duration" },
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

export function registerExporters(
  context: vscode.ExtensionContext,
  services: Services,
): vscode.TreeDataProvider<unknown> {
  const provider = new ExportersTreeProvider(services);
  context.subscriptions.push(provider);

  const treeView = vscode.window.createTreeView("jumpstarter.exporters", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => {
      const selected = e.selection[0];
      if (selected?.kind === "exporter") {
        showDetails({ kind: "exporter", exporter: selected.exporter });
      }
    }),
  );

  const poller = services.createPoller({
    name: "exporters",
    tick: () => provider.tick(),
  });
  provider.poller = poller;
  context.subscriptions.push(poller);
  context.subscriptions.push(
    // Ending a lease frees or recycles an exporter, so this view is stale
    // until it re-reads — do not make the user wait out the poll interval.
    // (an exporter's status follows its lease over the next seconds)
    services.onDidChangeLeases(() => void poller.watch()),
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

  /** Open a terminal running a jmp session; argv is logged redacted. */
  const openTerminal = async (
    name: string,
    getShell: () => Promise<{ command: string; args: string[] }>,
  ): Promise<void> => {
    try {
      const shell = await getShell();
      services.jmp.log(`terminal "${name}": ${shellQuote([shell.command, ...redactSecretArgs(shell.args)])}`);
      const terminal = vscode.window.createTerminal({
        name,
        shellPath: shell.command,
        shellArgs: shell.args,
        env: await services.jmp.getTerminalEnv(),
      });
      terminal.show();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Jumpstarter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const createLease = async (
    client: string,
    opts: { exporterName?: string; selector?: string; label?: string },
    duration: string,
  ): Promise<void> => {
    const target = opts.label ?? opts.exporterName ?? `selector '${opts.selector}'`;
    // The request is shown in the lease views until the lease is held: it is
    // made at once, and bound when an exporter is there (a pool may have to
    // provision one first).
    await acquireLease(
      services,
      {
        client,
        label: opts.label ?? opts.exporterName ?? opts.selector ?? "an exporter",
        target: `on ${target}`,
        create: () =>
          services.jmp.createLease(client, {
            exporterName: opts.exporterName,
            selector: opts.selector,
            duration,
          }),
      },
      (message) => void vscode.window.showErrorMessage(`Jumpstarter: failed to create lease: ${message}`),
    );
    // Leasing changes this view too: the exporter is now held, and a pool may
    // have recycled or provisioned behind it.
    void poller.refreshNow();
  };

  context.subscriptions.push(
    // View-title refresh button.
    vscode.commands.registerCommand("jumpstarter.exporters.refresh", () => {
      services.jmp.forgetSharedReads(); // asked for by hand: read everything again
      poller.start();
      return poller.refreshNow();
    }),

    // Serve a local exporter config and open a session against it. There is
    // no controller and no lease: the config is served from this machine.
    vscode.commands.registerCommand(
      "jumpstarter.exporters.openLocalShell",
      async (node?: ExportersNode) => {
        const config = node?.kind === "localExporter" ? node.config : undefined;
        if (!config) {
          void vscode.window.showInformationMessage(
            "Select a local exporter in the Jumpstarter Exporters view first.",
          );
          return;
        }
        await openTerminal(
          `jmp shell --exporter ${config.alias}`,
          () => services.jmp.getLocalExporterShellCommand(config.alias),
        );
      },
    ),

    // Connect straight to a standalone exporter, bypassing the controller.
    vscode.commands.registerCommand("jumpstarter.connectDirect", async () => {
      const address = await vscode.window.showInputBox({
        title: "Connect to an exporter directly",
        prompt: "Address the exporter serves on",
        placeHolder: "host:port",
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length === 0 || isValidAddress(value)
            ? undefined
            : "Enter an address as host:port",
      });
      if (!address) {
        return;
      }

      const tls = await vscode.window.showQuickPick(
        [
          { label: "TLS", description: "verify the exporter's certificate", insecure: false },
          { label: "No TLS", description: "plaintext connection", insecure: true },
        ],
        { title: `Connect to ${address.trim()}`, placeHolder: "Transport" },
      );
      if (!tls) {
        return;
      }

      const passphrase = await vscode.window.showInputBox({
        title: `Connect to ${address.trim()}`,
        prompt: "Passphrase, if the exporter requires one",
        placeHolder: "leave empty for none",
        password: true,
        ignoreFocusOut: true,
      });
      if (passphrase === undefined) {
        return;
      }

      await openTerminal(`jmp shell ${address.trim()}`, () =>
        services.jmp.getDirectShellCommand({
          address: address.trim(),
          insecure: tls.insecure,
          passphrase: passphrase.length > 0 ? passphrase : undefined,
        }),
      );
    }),

    // Lease any member of a pool: the selector matches every exporter the set
    // owns, so the controller is free to pick one (and to provision another to
    // refill the pool's warm buffer).
    vscode.commands.registerCommand(
      "jumpstarter.exporters.leaseFromSet",
      async (node?: ExportersNode) => {
        const group = node?.kind === "exporterSet" ? node.group : undefined;
        if (!group) {
          void vscode.window.showInformationMessage(
            "Select an exporter set in the Jumpstarter Exporters view first.",
          );
          return;
        }
        const client = provider.activeClient;
        if (!client) {
          void vscode.window.showWarningMessage("Jumpstarter: no current client selected.");
          return;
        }
        const duration = await pickDuration(`Lease from ${group.name}`);
        if (!duration) {
          return;
        }
        await createLease(
          client,
          { selector: exporterSetSelector(group.name), label: `pool ${group.name}` },
          duration,
        );
      },
    ),

    // Only offered on rows carrying a configPath (contextValue ends "-local").
    vscode.commands.registerCommand(
      "jumpstarter.exporters.editConfig",
      async (node?: ExportersNode) => {
        // Both a registered exporter with a local config and a local-only one.
        const target =
          node?.kind === "exporter"
            ? { path: node.configPath, name: node.exporter.name }
            : node?.kind === "localExporter"
              ? { path: node.config.path, name: node.config.alias }
              : undefined;
        if (!target?.path) {
          void vscode.window.showInformationMessage(
            "This exporter has no configuration file on this machine.",
          );
          return;
        }
        await openConfigForEditing(services, target.path, `Exporter config '${target.name}'`);
      },
    ),

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

  return provider;
}
