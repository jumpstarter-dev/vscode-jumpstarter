/**
 * Administration feature — tree view `jumpstarter.admin`.
 *
 * Everything else in the extension looks at the cluster through one client's
 * eyes: the exporters that client may reach, the leases it owns. This view
 * looks through the kubeconfig instead, so it shows every client, exporter,
 * exporter set and lease in a namespace, whoever owns them.
 *
 * It only appears when that is actually possible — a kubeconfig that resolves
 * and a cluster serving the Jumpstarter CRDs — which is what the
 * `jumpstarter.adminAvailable` context key gates.
 *
 * Wire-up: registerAdmin(context, services) from extension.ts.
 */

import * as vscode from "vscode";
import {
  AdminOptions,
  configuredPollIntervalSeconds,
  describePending,
  PendingLease,
  Poller,
  Services,
} from "../services";
import {
  AdminClient,
  AdminExporter,
  AdminExporterSet,
  AdminLease,
  ClientConfigList,
} from "../types";
import {
  clientRow,
  describeLabels,
  exporterRow,
  exporterSetRow,
  importedClientNames,
  isLeaseActive,
  leaseRow,
  memberLabels,
  pickAdminNamespace,
  RowSpec,
  sortByName,
  sortLeases,
} from "./admin/model";
import { iconForCategory } from "./exporters/model";
import { resolveIcon } from "./icons";
import { importConfigFromCluster } from "./manifests";

// ---------------------------------------------------------------------------
// Tree nodes
// ---------------------------------------------------------------------------

type CategoryId = "clients" | "exporters" | "exporterSets" | "leases";

interface CategoryNode {
  kind: "category";
  id: CategoryId;
  label: string;
  count: number;
  iconId: string;
}

interface ClientNode {
  kind: "client";
  client: AdminClient;
  /** True when a config for this client already exists on this machine. */
  imported: boolean;
}

interface ExporterNode {
  kind: "exporter";
  exporter: AdminExporter;
}

interface ExporterSetNode {
  kind: "exporterSet";
  set: AdminExporterSet;
}

interface SetMemberNode {
  kind: "setMember";
  name: string;
  labels: Record<string, string>;
  /** The member's own exporter object, when the namespace listing has it. */
  exporter?: AdminExporter;
}

interface LeaseNode {
  kind: "lease";
  lease: AdminLease;
}

/** A lease this session has asked for that the cluster has not stored yet. */
interface PendingLeaseNode {
  kind: "pendingLease";
  pending: PendingLease;
}

interface MessageNode {
  kind: "message";
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
}

type AdminNode =
  | CategoryNode
  | ClientNode
  | ExporterNode
  | ExporterSetNode
  | SetMemberNode
  | LeaseNode
  | PendingLeaseNode
  | MessageNode;

interface AdminData {
  clients: AdminClient[];
  exporters: AdminExporter[];
  sets: AdminExporterSet[];
  leases: AdminLease[];
  importedClients: Set<string>;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; data: AdminData };

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

class AdminTreeProvider implements vscode.TreeDataProvider<AdminNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this.changeEmitter.event;

  private state: ViewState = { kind: "loading" };
  private tickSeq = 0;
  private showEndedLeases = false;
  poller: Poller | undefined;

  constructor(
    private readonly services: Services,
    private readonly resolveOptions: (clients?: ClientConfigList | null) => Promise<AdminOptions>,
  ) {}

  get endedLeasesShown(): boolean {
    return this.showEndedLeases;
  }

  toggleEndedLeases(): void {
    this.showEndedLeases = !this.showEndedLeases;
    this.changeEmitter.fire();
  }

  async tick(): Promise<void> {
    const seq = ++this.tickSeq;
    const apply = (state: ViewState): void => {
      if (seq === this.tickSeq) {
        this.state = state;
        this.changeEmitter.fire();
      }
    };

    try {
      // Read the local configs once: they decide which namespace to show and
      // which of its clients are already imported here.
      let localClients: ClientConfigList | null = null;
      try {
        localClients = await this.services.jmp.listClients();
      } catch {
        // Local configs are a nicety here; the cluster listing is the point.
      }
      const options = await this.resolveOptions(localClients);
      // One namespace, four listings; a failure in any of them is a failure of
      // the whole view, since a half-read namespace is misleading here.
      const [clients, exporters, leases, sets] = await Promise.all([
        this.services.jmp.adminClients(options),
        this.services.jmp.adminExporters(options),
        this.services.jmp.adminLeases(options),
        this.services.jmp.adminExporterSets(options).catch(() => [] as AdminExporterSet[]),
      ]);
      const importedClients = importedClientNames(localClients);
      apply({
        kind: "data",
        data: {
          clients: sortByName(clients),
          exporters: sortByName(exporters),
          sets: sortByName(sets),
          leases: sortLeases(leases),
          importedClients,
        },
      });
    } catch (err) {
      apply({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private visibleLeases(data: AdminData): AdminLease[] {
    return this.showEndedLeases ? data.leases : data.leases.filter(isLeaseActive);
  }

  getChildren(element?: AdminNode): AdminNode[] {
    if (this.state.kind === "loading") {
      return element
        ? []
        : [{ kind: "message", label: "Reading the cluster…", iconId: "loading~spin" }];
    }
    if (this.state.kind === "error") {
      return element ? [] : [{ kind: "message", label: this.state.message, iconId: "error" }];
    }
    const data = this.state.data;

    if (!element) {
      const leases = this.visibleLeases(data);
      return [
        {
          kind: "category",
          id: "clients",
          label: "Clients",
          count: data.clients.length,
          iconId: "account",
        },
        {
          kind: "category",
          id: "exporters",
          label: "Exporters",
          count: data.exporters.length,
          iconId: "server",
        },
        ...(data.sets.length > 0
          ? [
              {
                kind: "category" as const,
                id: "exporterSets" as const,
                label: "Exporter Sets",
                count: data.sets.length,
                iconId: "layers",
              },
            ]
          : []),
        {
          kind: "category",
          id: "leases",
          label: "Leases",
          count: leases.length,
          // A lease is a held resource; `key` means authentication elsewhere
          // in the extension and should not mean two things.
          iconId: "lock",
        },
      ];
    }

    switch (element.kind) {
      case "category":
        return this.categoryChildren(element.id, data);
      case "exporterSet": {
        // Members are ordinary exporters, so pair each with the one from the
        // namespace listing and it renders exactly as it does everywhere else.
        const byName = new Map(data.exporters.map((e) => [e.metadata.name, e]));
        return (element.set.exporters ?? []).map((member) => ({
          kind: "setMember",
          name: member.name,
          labels: member.labels ?? {},
          exporter: byName.get(member.name),
        }));
      }
      default:
        return [];
    }
  }

  private categoryChildren(id: CategoryId, data: AdminData): AdminNode[] {
    const empty = (label: string): AdminNode[] => [{ kind: "message", label, iconId: "info" }];
    switch (id) {
      case "clients":
        return data.clients.length === 0
          ? empty("No clients in this namespace")
          : data.clients.map((client) => ({
              kind: "client",
              client,
              imported: data.importedClients.has(client.metadata.name),
            }));
      case "exporters":
        return data.exporters.length === 0
          ? empty("No exporters in this namespace")
          : data.exporters.map((exporter) => ({ kind: "exporter", exporter }));
      case "exporterSets":
        return data.sets.map((set) => ({ kind: "exporterSet", set }));
      case "leases": {
        const leases = this.visibleLeases(data);
        // Requests this session has made but the cluster has not stored yet.
        const pending: AdminNode[] = (this.services.pendingLeases?.all() ?? []).map((entry) => ({
          kind: "pendingLease",
          pending: entry,
        }));
        if (leases.length === 0) {
          return pending.length > 0
            ? pending
            : empty(this.showEndedLeases ? "No leases in this namespace" : "No active leases");
        }
        return [...pending, ...leases.map((lease): AdminNode => ({ kind: "lease", lease }))];
      }
    }
  }

  getTreeItem(node: AdminNode): vscode.TreeItem {
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.contextValue = "admin-message";
      if (node.iconId) {
        item.iconPath = new vscode.ThemeIcon(node.iconId);
      }
      return item;
    }

    if (node.kind === "category") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `admin/${node.id}`;
      item.description = String(node.count);
      item.contextValue = `admin-category-${node.id}`;
      item.iconPath = new vscode.ThemeIcon(node.iconId);
      return item;
    }

    if (node.kind === "pendingLease") {
      const item = new vscode.TreeItem(node.pending.label, vscode.TreeItemCollapsibleState.None);
      item.id = `admin/pending/${node.pending.id}`;
      item.description = describePending(node.pending);
      item.tooltip = new vscode.MarkdownString(
        `**${node.pending.label}**\n\nRequested through \`${node.pending.client}\`; the controller has not granted it yet.`,
      );
      item.contextValue = "admin-lease-pending";
      item.iconPath = new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
      return item;
    }

    if (node.kind === "setMember") {
      const spec = node.exporter
        ? exporterRow(node.exporter)
        : {
            label: node.name,
            description: describeLabels(memberLabels(node.labels)),
            tooltipMarkdown: `**${node.name}**\n\nProvisioned by this set; the namespace listing does not have it yet.`,
            icon: iconForCategory("unknown"),
          };
      const item = new vscode.TreeItem(spec.label, vscode.TreeItemCollapsibleState.None);
      item.id = `admin/setMember/${node.name}`;
      // The pool row above already says which set these belong to, so the
      // membership labels are noise on every one of its members.
      item.description = node.exporter
        ? describeLabels(memberLabels(node.exporter.metadata.labels))
        : spec.description;
      item.tooltip = new vscode.MarkdownString(spec.tooltipMarkdown);
      item.contextValue = "admin-set-member";
      item.iconPath = resolveIcon(spec.icon);
      return item;
    }

    const { spec, id, contextValue, collapsible } = this.describe(node);
    const item = new vscode.TreeItem(spec.label, collapsible);
    item.id = id;
    item.description = spec.description;
    const tooltip = new vscode.MarkdownString(spec.tooltipMarkdown);
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.contextValue = contextValue;
    item.iconPath = resolveIcon(spec.icon);
    return item;
  }

  private describe(node: ClientNode | ExporterNode | ExporterSetNode | LeaseNode): {
    spec: RowSpec;
    id: string;
    contextValue: string;
    collapsible: vscode.TreeItemCollapsibleState;
  } {
    switch (node.kind) {
      case "client": {
        const spec = clientRow(node.client);
        return {
          spec: node.imported
            ? { ...spec, description: [spec.description, "imported"].filter(Boolean).join(" · ") }
            : spec,
          id: `admin/client/${node.client.metadata.name}`,
          // Importing twice is refused by the CLI, so only offer it once.
          contextValue: node.imported ? "admin-client-imported" : "admin-client",
          collapsible: vscode.TreeItemCollapsibleState.None,
        };
      }
      case "exporter":
        return {
          spec: exporterRow(node.exporter),
          id: `admin/exporter/${node.exporter.metadata.name}`,
          contextValue: "admin-exporter",
          collapsible: vscode.TreeItemCollapsibleState.None,
        };
      case "exporterSet":
        return {
          spec: exporterSetRow(node.set),
          id: `admin/exporterset/${node.set.metadata.name}`,
          contextValue: "admin-exporter-set",
          collapsible:
            (node.set.exporters ?? []).length > 0
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
        };
      case "lease":
        return {
          spec: leaseRow(node.lease),
          id: `admin/lease/${node.lease.metadata.name}`,
          contextValue: "admin-lease",
          collapsible: vscode.TreeItemCollapsibleState.None,
        };
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Read the admin connection settings, filling the namespace in from context.
 *
 * Pass `clients` when the caller has already listed the local configs, so the
 * namespace can be derived without spawning the CLI a second time.
 */
export async function resolveAdminOptions(
  services: Services,
  clients?: ClientConfigList | null,
): Promise<AdminOptions> {
  const config = vscode.workspace.getConfiguration("jumpstarter.admin");
  let localClients = clients;
  if (localClients === undefined) {
    try {
      localClients = await services.jmp.listClients();
    } catch {
      // No client configs yet: fall back to the configured or default namespace.
      localClients = null;
    }
  }
  const options: AdminOptions = {
    namespace: pickAdminNamespace(config.get<string>("namespace", ""), localClients),
  };
  const kubeconfig = config.get<string>("kubeconfig", "").trim();
  if (kubeconfig.length > 0) {
    options.kubeconfig = kubeconfig;
  }
  const context = config.get<string>("context", "").trim();
  if (context.length > 0) {
    options.context = context;
  }
  return options;
}

export function registerAdmin(context: vscode.ExtensionContext, services: Services): void {
  const options = (clients?: ClientConfigList | null) => resolveAdminOptions(services, clients);
  const provider = new AdminTreeProvider(services, options);
  context.subscriptions.push(provider);

  const treeView = vscode.window.createTreeView("jumpstarter.admin", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // A namespace's registry of clients and exporters changes far more slowly
  // than lease state does, and reading it costs four CLI calls, so this view
  // polls at half the rate of the others.
  const poller = services.createPoller({
    name: "admin",
    tick: () => provider.tick(),
    intervalSeconds: () => Math.max(30, configuredPollIntervalSeconds() * 2),
  });
  provider.poller = poller;
  context.subscriptions.push(poller);
  context.subscriptions.push(treeView.onDidChangeVisibility((e) => poller.setVisible(e.visible)));
  poller.setVisible(treeView.visible);

  /**
   * Decide whether this machine can administer a cluster, and show or hide
   * the view accordingly. Polling only runs once the answer is yes, so a
   * machine with no kubeconfig never pays for this feature.
   */
  const probe = async (): Promise<boolean> => {
    const availability = services.jmp.getAvailability();
    if (availability && availability.kind !== "ok") {
      await vscode.commands.executeCommand("setContext", "jumpstarter.adminAvailable", false);
      poller.stop();
      return false;
    }
    const result = await services.jmp.probeAdmin(await options());
    await vscode.commands.executeCommand("setContext", "jumpstarter.adminAvailable", result.ok);
    if (result.ok) {
      poller.start();
      void poller.refreshNow();
    } else {
      poller.stop();
    }
    return result.ok;
  };

  void probe();
  context.subscriptions.push(
    services.jmp.onDidChangeAvailability(() => void probe()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("jumpstarter.admin")) {
        void probe();
      }
    }),
    // Leases created anywhere show up here too.
    services.onDidChangeLeases(() => void poller.refreshNow()),
  );

  const describeNamespace = async (): Promise<string> => (await options()).namespace ?? "default";
  void describeNamespace().then((ns) => (treeView.description = ns));

  context.subscriptions.push(
    vscode.commands.registerCommand("jumpstarter.admin.refresh", async () => {
      if (await probe()) {
        await poller.refreshNow();
      }
      treeView.description = await describeNamespace();
    }),

    vscode.commands.registerCommand("jumpstarter.admin.toggleEndedLeases", () => {
      provider.toggleEndedLeases();
    }),

    // Which namespace to administer. Stored globally: it describes the
    // cluster this machine talks to, not the folder that happens to be open.
    vscode.commands.registerCommand("jumpstarter.admin.setNamespace", async () => {
      const current = await describeNamespace();
      const namespace = await vscode.window.showInputBox({
        title: "Administer namespace",
        prompt: "Kubernetes namespace to administer (empty follows the current client)",
        value: vscode.workspace.getConfiguration("jumpstarter.admin").get<string>("namespace", ""),
        placeHolder: current,
        ignoreFocusOut: true,
      });
      if (namespace === undefined) {
        return;
      }
      await vscode.workspace
        .getConfiguration("jumpstarter.admin")
        .update("namespace", namespace.trim(), vscode.ConfigurationTarget.Global);
      treeView.description = await describeNamespace();
      await poller.refreshNow();
    }),

    // Import the config the cluster issued for an existing client or exporter.
    vscode.commands.registerCommand("jumpstarter.admin.importClient", async (node?: AdminNode) => {
      const name = node?.kind === "client" ? node.client.metadata.name : undefined;
      await importConfigFromCluster(services, "client", await options(), name);
      await poller.refreshNow();
    }),

    vscode.commands.registerCommand(
      "jumpstarter.admin.importExporter",
      async (node?: AdminNode) => {
        const name = node?.kind === "exporter" ? node.exporter.metadata.name : undefined;
        await importConfigFromCluster(services, "exporter", await options(), name);
        await poller.refreshNow();
      },
    ),
  );
}
