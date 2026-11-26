/**
 * TreeDataProvider for the Leases view (view id: jumpstarter.leases).
 *
 * Root nodes are the leases of the active client (or a message node while
 * loading / when no client is selected / on auth expiry). In-Use leases
 * expand into a driver tree fetched lazily via
 * `jmp describe lease <name> --drivers` and cached per lease; driver fetch
 * failures render as an inline error node (never a modal).
 *
 * A lease with members (one exporter for each role) expands into its roles
 * and forwards instead; each bound role then expands into that role's driver
 * tree, read once for all the roles of the lease from inside its session.
 */

import * as vscode from "vscode";
import { ExporterPort, Lease, LeaseDriverTree, isLeaseUsable } from "../../types";
import { describePending, describeReleasing, leasesStillPending, JmpService, JmpError, PendingLease, PendingLeaseStore } from "../../services";
import type { RoleDrivers } from "../../services/leaseProtocol";
import * as model from "./model";
import * as members from "./members";

export interface MessageNode {
  kind: "message";
  text: string;
  icon?: string;
  iconColor?: string;
  tooltip?: string;
  /** Click action, e.g. retry. */
  command?: vscode.Command;
}

export interface LeaseNode {
  kind: "lease";
  client: string;
  lease: Lease;
}

/** A lease this session has asked for and not been granted yet. */
export interface PendingLeaseNode {
  kind: "pending";
  pending: PendingLease;
}

export interface DriverNode {
  kind: "driver";
  client: string;
  leaseName: string;
  /** The role the driver belongs to, for a lease with members. */
  role?: string;
  descriptor: model.DriverNodeDescriptor;
}

export interface CommandNode {
  kind: "command";
  client: string;
  leaseName: string;
  /** The role the command addresses, for a lease with members. */
  role?: string;
  descriptor: model.CommandDescriptor;
}

/** One role of a lease with members. */
export interface RoleNode {
  kind: "role";
  client: string;
  lease: Lease;
  leaseName: string;
  role: members.RoleDescriptor;
}

/** One forward of a lease with members. */
export interface ForwardNode {
  kind: "forward";
  client: string;
  lease: Lease;
  forward: members.ForwardDescriptor;
}

export type LeaseTreeNode =
  | MessageNode
  | LeaseNode
  | PendingLeaseNode
  | RoleNode
  | ForwardNode
  | DriverNode
  | CommandNode;

type RootState =
  | { kind: "loading" }
  | { kind: "no-client" }
  | { kind: "auth-expired"; client: string }
  | { kind: "error"; message: string }
  | { kind: "data"; client: string; leases: Lease[] };

interface DriverTreeCacheEntry {
  promise?: Promise<LeaseDriverTree>;
  driverTree?: LeaseDriverTree;
  error?: string;
}

/** The driver trees of the roles of one lease with members: one read serves every role. */
interface RoleTreesCacheEntry {
  promise: Promise<Record<string, RoleDrivers>>;
  roles?: Record<string, RoleDrivers>;
  error?: string;
}

export class LeasesTreeProvider implements vscode.TreeDataProvider<LeaseTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<LeaseTreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<LeaseTreeNode | undefined> =
    this.changeEmitter.event;

  private state: RootState = { kind: "loading" };
  private readonly driverTreeCache = new Map<string, DriverTreeCacheEntry>();
  private readonly roleTreesCache = new Map<string, RoleTreesCacheEntry>();
  /** The ports each exporter declares, by exporter: what gives a forward its arrow. */
  private portsByExporter: Readonly<Record<string, readonly ExporterPort[]>> = {};
  /** Whether a driver client class has a view in Jumpstarter Web; see setWebViewLookup. */
  private hasWebView: (driverClass: string, driverPath: readonly string[]) => boolean = () => false;

  /** The leases that were ended and are not released yet, with when each was ended. */
  private readonly releasing = new Map<string, number>();

  constructor(
    private readonly jmp: JmpService,
    private readonly pendingLeases?: PendingLeaseStore,
  ) {}

  /** A lease was ended: its row says so until `released`. Re-renders. */
  markReleasing(leaseName: string, now = Date.now()): void {
    this.releasing.set(leaseName, now);
    this.changeEmitter.fire(undefined);
  }

  /** The end of a lease is over, however it went: its row is as the listing has it (or gone). Re-renders. */
  released(leaseName: string): void {
    if (this.releasing.delete(leaseName)) {
      this.changeEmitter.fire(undefined);
    }
  }

  isReleasing(leaseName: string): boolean {
    return this.releasing.has(leaseName);
  }

  /**
   * Tell the tree which driver clients have a view of their own in
   * Jumpstarter Web, so those rows can offer to open it. Re-renders.
   */
  setWebViewLookup(lookup: (driverClass: string, driverPath: readonly string[]) => boolean): void {
    this.hasWebView = lookup;
    this.changeEmitter.fire(undefined);
  }

  /**
   * Tell the tree which ports the exporters declare, so the forwards of a
   * lease are drawn with their direction. Re-renders.
   */
  setExporterPorts(ports: Readonly<Record<string, readonly ExporterPort[]>>): void {
    this.portsByExporter = ports;
    this.changeEmitter.fire(undefined);
  }

  private directionsOf(lease: Lease): members.DirectionLookup {
    return members.portDirections(lease, this.portsByExporter);
  }

  private clearDriverCaches(): void {
    this.driverTreeCache.clear();
    this.roleTreesCache.clear();
  }

  // -- state transitions (called by the feature's poller tick) --------------

  /** Current client alias when data is loaded. */
  get client(): string | null {
    return this.state.kind === "data"
      ? this.state.client
      : this.state.kind === "auth-expired"
        ? this.state.client
        : null;
  }

  /** Leases currently displayed (empty outside the data state). */
  get leases(): readonly Lease[] {
    return this.state.kind === "data" ? this.state.leases : [];
  }

  setLeases(client: string, leases: Lease[]): void {
    if (this.state.kind !== "data" || this.state.client !== client) {
      // Client switched (or first data): driver sessions belong to the old
      // client, drop them all.
      this.clearDriverCaches();
    } else {
      // Drop cached driver trees for leases that are gone or no longer in use.
      const inUse = new Set(
        leases.filter((l) => isLeaseUsable(l.status)).map((l) => l.name),
      );
      for (const cache of [this.driverTreeCache, this.roleTreesCache]) {
        for (const name of [...cache.keys()]) {
          if (!inUse.has(name)) {
            cache.delete(name);
          }
        }
      }
      // A role that was bound to another exporter since has another driver tree.
      const before = new Map(this.state.leases.map((l) => [l.name, boundRoles(l)]));
      for (const lease of leases) {
        if (this.roleTreesCache.has(lease.name) && before.get(lease.name) !== boundRoles(lease)) {
          this.roleTreesCache.delete(lease.name);
        }
      }
    }
    this.state = { kind: "data", client, leases };
    this.changeEmitter.fire(undefined);
  }

  setNoClient(): void {
    this.clearDriverCaches();
    this.state = { kind: "no-client" };
    this.changeEmitter.fire(undefined);
  }

  setAuthExpired(client: string): void {
    this.clearDriverCaches();
    this.state = { kind: "auth-expired", client };
    this.changeEmitter.fire(undefined);
  }

  /**
   * Record a refresh failure. Existing lease data is kept (stale beats
   * empty); the message replaces the tree only when there is nothing to show.
   * Returns true when the tree now shows the error.
   */
  setError(message: string): boolean {
    if (this.state.kind === "data") {
      return false;
    }
    this.state = { kind: "error", message };
    this.changeEmitter.fire(undefined);
    return true;
  }

  /** Re-render rows so remaining-time descriptions tick without a jmp call. */
  refreshCountdowns(): void {
    if (this.state.kind === "data" && this.state.leases.length > 0) {
      this.changeEmitter.fire(undefined);
    }
  }

  /** Drop one driver tree, or all of them after an environment/capability change. */
  refreshDrivers(leaseName?: string): void {
    if (leaseName === undefined) {
      this.clearDriverCaches();
    } else {
      this.driverTreeCache.delete(leaseName);
      this.roleTreesCache.delete(leaseName);
    }
    this.changeEmitter.fire(undefined);
  }

  /** True while any lease in use with a begin time is displayed. */
  hasTickingLeases(): boolean {
    return (
      // (a lease on its way in or out counts the seconds it has taken)
      this.releasing.size > 0 ||
      (this.pendingLeases?.all().length ?? 0) > 0 ||
      (this.state.kind === "data" &&
        this.state.leases.some((l) => isLeaseUsable(l.status) && l.effective_begin_time !== null))
    );
  }

  // -- TreeDataProvider -----------------------------------------------------

  getTreeItem(node: LeaseTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "message":
        return this.messageItem(node);
      case "lease":
        return this.leaseItem(node);
      case "pending":
        return this.pendingItem(node);
      case "role":
        return this.memberItem(members.buildRoleRow(node.lease, node.role, members.isWorkable(node.lease)));
      case "forward":
        return this.memberItem(members.buildForwardRow(node.lease, node.forward));
      case "driver":
        return this.driverItem(node);
      case "command":
        return this.commandItem(node);
    }
  }

  async getChildren(node?: LeaseTreeNode): Promise<LeaseTreeNode[]> {
    if (!node) {
      return this.rootChildren();
    }
    if (node.kind === "lease") {
      return members.isMemberLease(node.lease) ? this.memberChildren(node) : this.driverChildren(node);
    }
    if (node.kind === "role") {
      return this.roleDriverChildren(node);
    }
    if (node.kind === "driver") {
      return node.descriptor.commands.map((descriptor) => ({
        kind: "command",
        client: node.client,
        leaseName: node.leaseName,
        ...(node.role ? { role: node.role } : {}),
        descriptor,
      }));
    }
    return [];
  }

  /**
   * What a lease with members shows under it: a notice when it is degraded,
   * its roles in the lease's order, then its forwards. Nothing is asked of
   * the CLI for this: it is all in the lease as it was listed.
   */
  private memberChildren(node: LeaseNode): LeaseTreeNode[] {
    const { lease, client } = node;
    const children: LeaseTreeNode[] = [];
    if (members.isDegraded(lease)) {
      children.push({
        kind: "message",
        text: members.describeDegraded(lease),
        icon: "warning",
        iconColor: "list.warningForeground",
        tooltip: "A role of this lease lost its exporter. The other roles stay usable.",
      });
    }
    for (const role of members.leaseRoles(lease)) {
      children.push({ kind: "role", client, lease, leaseName: lease.name, role });
    }
    for (const forward of members.leaseForwards(lease, this.directionsOf(lease))) {
      children.push({ kind: "forward", client, lease, forward });
    }
    return children;
  }

  /** The drivers of one bound role: the role's own driver tree, with commands that name the role. */
  private roleDriverChildren(node: RoleNode): Promise<LeaseTreeNode[]> {
    if (!members.isWorkable(node.lease) || !node.role.bound) {
      return Promise.resolve([]);
    }
    if (!this.jmp.hasCapability("describeDrivers")) {
      return Promise.resolve([
        {
          kind: "message",
          text: "Driver browsing requires the integration-branch CLI and jumpstarter.experimentalCliFeatures.",
          icon: "info",
        },
      ]);
    }
    const name = node.leaseName;
    let entry = this.roleTreesCache.get(name);
    if (!entry) {
      const created: RoleTreesCacheEntry = {
        promise: this.jmp.describeRoleDrivers(node.client, name).then(
          (roles) => {
            created.roles = roles;
            return roles;
          },
          (err: unknown) => {
            created.error = err instanceof JmpError ? err.message : String(err);
            throw err;
          },
        ),
      };
      // (a failure is shown by every role that waits for it; nothing is left unhandled)
      created.promise.catch(() => undefined);
      entry = created;
      this.roleTreesCache.set(name, entry);
    }
    const render = (roles: Record<string, RoleDrivers>): LeaseTreeNode[] => {
      const found = roles[node.role.name];
      if (!found) {
        return this.driverErrorNodes(name, `The session of the lease does not serve the role ${node.role.name}`);
      }
      if ("error" in found) {
        return this.driverErrorNodes(name, found.error);
      }
      const drivers = model.buildDriverNodes(found.driver_tree, node.role.name);
      if (drivers.length === 0) {
        return [{ kind: "message", text: "No drivers reported", icon: "info" }];
      }
      return drivers.map((descriptor) => ({
        kind: "driver",
        client: node.client,
        leaseName: name,
        role: node.role.name,
        descriptor,
      }));
    };
    if (entry.roles) {
      return Promise.resolve(render(entry.roles));
    }
    const pending = entry;
    return pending.promise.then(render, () =>
      this.driverErrorNodes(name, pending.error ?? "Failed to load drivers"),
    );
  }

  private rootChildren(): LeaseTreeNode[] {
    switch (this.state.kind) {
      case "loading":
        return [{ kind: "message", text: "Loading leases…", icon: "loading~spin" }];
      case "no-client":
        return [
          {
            kind: "message",
            text: "No Jumpstarter client selected",
            icon: "info",
            tooltip:
              "Select a client in the Clients view or run `jmp config client use <alias>` in a terminal.",
          },
        ];
      case "auth-expired":
        return [
          {
            kind: "message",
            text: `Client '${this.state.client}' needs re-authentication`,
            icon: "key",
            iconColor: "errorForeground",
            tooltip:
              "Run `jmp login` in a terminal (or re-authenticate from the Clients view), then click to retry.",
            command: {
              command: "jumpstarter.leases.refresh",
              title: "Retry",
            },
          },
        ];
      case "error":
        return [
          {
            kind: "message",
            text: this.state.message,
            icon: "warning",
            iconColor: "errorForeground",
            tooltip: "Click to retry.",
            command: { command: "jumpstarter.leases.refresh", title: "Retry" },
          },
        ];
      case "data": {
        const { client, leases } = this.state;
        // A request for a lease is a row among the leases, where its lease
        // will be once it is held: the row does not move when it is acquired.
        const requests = this.pendingLeases?.forClient(client) ?? [];
        // A lease that was made and is not held yet is its request's row, not
        // a second one that comes and goes.
        const requested = leasesStillPending(requests, client);
        const shown = leases.filter((lease) => !requested.has(lease.name));
        if (shown.length === 0 && requests.length === 0) {
          return [{ kind: "message", text: "No leases", icon: "info" }];
        }
        return model.orderLeaseRows(shown, requests, this.releasing).map(
          (row): LeaseTreeNode =>
            "lease" in row
              ? { kind: "lease", client, lease: row.lease }
              : { kind: "pending", pending: row.request },
        );
      }
    }
  }

  private driverChildren(node: LeaseNode): Promise<LeaseTreeNode[]> {
    if (!isLeaseUsable(node.lease.status)) {
      return Promise.resolve([]);
    }
    if (!this.jmp.hasCapability("describeDrivers")) {
      return Promise.resolve([
        {
          kind: "message",
          text: "Driver browsing requires the integration-branch CLI and jumpstarter.experimentalCliFeatures.",
          icon: "info",
        },
      ]);
    }
    const name = node.lease.name;
    let entry = this.driverTreeCache.get(name);
    if (!entry) {
      entry = {};
      entry.promise = this.jmp
        .describeLeaseWithDrivers(node.client, name)
        .then((result) => {
          entry!.driverTree = result.driver_tree;
          entry!.error = undefined;
          return result.driver_tree;
        })
        .catch((err: unknown) => {
          entry!.error = err instanceof JmpError ? err.message : String(err);
          throw err;
        });
      this.driverTreeCache.set(name, entry);
    }

    if (entry.driverTree) {
      return Promise.resolve(this.driverNodes(node, entry.driverTree));
    }
    if (entry.error) {
      return Promise.resolve(this.driverErrorNodes(name, entry.error));
    }
    return entry.promise!.then(
      (driverTree) => this.driverNodes(node, driverTree),
      () => this.driverErrorNodes(name, entry!.error ?? "Failed to load drivers"),
    );
  }

  private driverNodes(node: LeaseNode, driverTree: LeaseDriverTree): LeaseTreeNode[] {
    const drivers = model.buildDriverNodes(driverTree);
    if (drivers.length === 0) {
      return [{ kind: "message", text: "No drivers reported", icon: "info" }];
    }
    return drivers.map((descriptor) => ({
      kind: "driver",
      client: node.client,
      leaseName: node.lease.name,
      descriptor,
    }));
  }

  private driverErrorNodes(leaseName: string, message: string): LeaseTreeNode[] {
    return [
      {
        kind: "message",
        text: message,
        icon: "warning",
        iconColor: "errorForeground",
        tooltip: "The lease session may not be ready yet. Click to retry.",
        command: {
          command: "jumpstarter.leases.refreshDevices",
          title: "Retry",
          arguments: [{ leaseName }],
        },
      },
    ];
  }

  // -- TreeItem construction ------------------------------------------------

  private messageItem(node: MessageNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    if (node.icon) {
      item.iconPath = node.iconColor
        ? new vscode.ThemeIcon(node.icon, new vscode.ThemeColor(node.iconColor))
        : new vscode.ThemeIcon(node.icon);
    }
    item.tooltip = node.tooltip;
    item.command = node.command;
    item.contextValue = "jumpstarterLeaseMessage";
    return item;
  }

  private leaseItem(node: LeaseNode): vscode.TreeItem {
    const built = model.buildLeaseRow(node.lease, new Date(), this.directionsOf(node.lease));
    const endedAt = this.releasing.get(node.lease.name);
    const row =
      endedAt === undefined
        ? built
        : model.releasingLeaseRow(built, model.leaseTarget(node.lease), describeReleasing(endedAt));
    const item = new vscode.TreeItem(
      row.label,
      row.expandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.contextValue = row.contextValue;
    item.iconPath = row.iconColor
      ? new vscode.ThemeIcon(row.icon, new vscode.ThemeColor(row.iconColor))
      : new vscode.ThemeIcon(row.icon);
    return item;
  }

  /** A role or a forward of a lease with members. */
  private memberItem(row: members.MemberRowDescriptor): vscode.TreeItem {
    const item = new vscode.TreeItem(
      row.label,
      row.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.contextValue = row.contextValue;
    item.iconPath = row.iconColor
      ? new vscode.ThemeIcon(row.icon, new vscode.ThemeColor(row.iconColor))
      : new vscode.ThemeIcon(row.icon);
    return item;
  }

  private pendingItem(node: PendingLeaseNode): vscode.TreeItem {
    // Named like the lease it becomes, as soon as the controller has made it:
    // the lease's name, then what it is a lease of.
    const made = node.pending.leaseName;
    const item = new vscode.TreeItem(
      made ? model.shortLeaseName(made) : node.pending.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `jumpstarter.lease/${node.pending.id}`;
    item.description = made
      ? `${node.pending.label} · ${describePending(node.pending)}`
      : describePending(node.pending);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${node.pending.label}**`,
        "",
        "Waiting for the controller to grant this lease.",
        "",
        "A pool with nothing warm has to provision an exporter first, which can take a while.",
      ].join("\n"),
    );
    // No actions: there is nothing to open or end until the lease exists.
    item.contextValue = "jumpstarterLeasePending";
    item.iconPath = new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
    return item;
  }

  private driverItem(node: DriverNode): vscode.TreeItem {
    const d = node.descriptor;
    const item = new vscode.TreeItem(
      d.label,
      d.commands.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `jumpstarter.driver/${node.leaseName}/${node.role ? `${node.role}/` : ""}${d.id}`;
    item.description = d.description;
    item.tooltip = d.tooltip;
    item.contextValue = this.hasWebView(d.driverClass, d.driverPath) ? "jumpstarterDriver-web" : "jumpstarterDriver";
    item.iconPath = new vscode.ThemeIcon("circuit-board");
    return item;
  }

  private commandItem(node: CommandNode): vscode.TreeItem {
    const d = node.descriptor;
    const item = new vscode.TreeItem(d.label, vscode.TreeItemCollapsibleState.None);
    item.id = `jumpstarter.command/${node.leaseName}/${[...(node.role ? [node.role] : []), ...d.cliPath].join("/")}`;
    item.tooltip = d.tooltip;
    item.contextValue = "jumpstarterDeviceCommand";
    item.iconPath = new vscode.ThemeIcon("play");
    item.command = {
      command: "jumpstarter.leases.runDeviceCommand",
      title: "Run in Lease",
      arguments: [node],
    };
    return item;
  }

  /** Re-render from the state already held (no CLI call). */
  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Which exporter each role of a lease is bound to, as one comparable text. */
function boundRoles(lease: Lease): string {
  return members
    .leaseRoles(lease)
    .map((role) => `${role.name}=${role.bound ? role.exporter : ""}`)
    .join(",");
}
