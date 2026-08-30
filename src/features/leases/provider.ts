/**
 * TreeDataProvider for the Leases view (view id: jumpstarter.leases).
 *
 * Root nodes are the leases of the active client (or a message node while
 * loading / when no client is selected / on auth expiry). In-Use leases
 * expand into a device tree fetched lazily via
 * `jmp describe lease <name> --devices` and cached per lease; device fetch
 * failures render as an inline error node (never a modal).
 */

import * as vscode from "vscode";
import { Lease, LeaseDevices } from "../../types";
import { describePending, JmpService, JmpError, PendingLease, PendingLeaseStore } from "../../services";
import * as model from "./model";

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
  descriptor: model.DriverNodeDescriptor;
}

export interface CommandNode {
  kind: "command";
  client: string;
  leaseName: string;
  descriptor: model.CommandDescriptor;
}

export type LeaseTreeNode =
  | MessageNode
  | LeaseNode
  | PendingLeaseNode
  | DriverNode
  | CommandNode;

type RootState =
  | { kind: "loading" }
  | { kind: "no-client" }
  | { kind: "auth-expired"; client: string }
  | { kind: "error"; message: string }
  | { kind: "data"; client: string; leases: Lease[] };

interface DevicesCacheEntry {
  promise?: Promise<LeaseDevices>;
  devices?: LeaseDevices;
  error?: string;
}

export class LeasesTreeProvider implements vscode.TreeDataProvider<LeaseTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<LeaseTreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<LeaseTreeNode | undefined> =
    this.changeEmitter.event;

  private state: RootState = { kind: "loading" };
  private readonly devicesCache = new Map<string, DevicesCacheEntry>();

  constructor(
    private readonly jmp: JmpService,
    private readonly pendingLeases?: PendingLeaseStore,
  ) {}

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
      // Client switched (or first data): device sessions belong to the old
      // client, drop them all.
      this.devicesCache.clear();
    } else {
      // Drop cached device trees for leases that are gone or no longer In-Use.
      const inUse = new Set(
        leases.filter((l) => l.status === "In-Use").map((l) => l.name),
      );
      for (const name of [...this.devicesCache.keys()]) {
        if (!inUse.has(name)) {
          this.devicesCache.delete(name);
        }
      }
    }
    this.state = { kind: "data", client, leases };
    this.changeEmitter.fire(undefined);
  }

  setNoClient(): void {
    this.devicesCache.clear();
    this.state = { kind: "no-client" };
    this.changeEmitter.fire(undefined);
  }

  setAuthExpired(client: string): void {
    this.devicesCache.clear();
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

  /** Drop the cached device tree for a lease and re-render. */
  refreshDevices(leaseName: string): void {
    this.devicesCache.delete(leaseName);
    this.changeEmitter.fire(undefined);
  }

  /** True while any In-Use lease with a begin time is displayed. */
  hasTickingLeases(): boolean {
    return (
      this.state.kind === "data" &&
      this.state.leases.some((l) => l.status === "In-Use" && l.effective_begin_time !== null)
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
      return this.deviceChildren(node);
    }
    if (node.kind === "driver") {
      return node.descriptor.commands.map((descriptor) => ({
        kind: "command",
        client: node.client,
        leaseName: node.leaseName,
        descriptor,
      }));
    }
    return [];
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
        // Requests still in flight sit at the top: they are the newest thing
        // that happened, and they are what the user is waiting on.
        const pending: LeaseTreeNode[] = (this.pendingLeases?.forClient(client) ?? []).map(
          (entry) => ({ kind: "pending", pending: entry }),
        );
        if (leases.length === 0) {
          return pending.length > 0
            ? pending
            : [{ kind: "message", text: "No leases", icon: "info" }];
        }
        return [
          ...pending,
          ...model.sortLeases(leases).map((lease): LeaseTreeNode => ({
            kind: "lease",
            client,
            lease,
          })),
        ];
      }
    }
  }

  private deviceChildren(node: LeaseNode): Promise<LeaseTreeNode[]> {
    if (node.lease.status !== "In-Use") {
      return Promise.resolve([]);
    }
    const name = node.lease.name;
    let entry = this.devicesCache.get(name);
    if (!entry) {
      entry = {};
      entry.promise = this.jmp
        .describeLeaseWithDevices(node.client, name)
        .then((result) => {
          entry!.devices = result.devices;
          entry!.error = undefined;
          return result.devices;
        })
        .catch((err: unknown) => {
          entry!.error = err instanceof JmpError ? err.message : String(err);
          throw err;
        });
      this.devicesCache.set(name, entry);
    }

    if (entry.devices) {
      return Promise.resolve(this.driverNodes(node, entry.devices));
    }
    if (entry.error) {
      return Promise.resolve(this.deviceErrorNodes(name, entry.error));
    }
    return entry.promise!.then(
      (devices) => this.driverNodes(node, devices),
      () => this.deviceErrorNodes(name, entry!.error ?? "Failed to load devices"),
    );
  }

  private driverNodes(node: LeaseNode, devices: LeaseDevices): LeaseTreeNode[] {
    const drivers = model.buildDriverNodes(devices);
    if (drivers.length === 0) {
      return [{ kind: "message", text: "No devices reported", icon: "info" }];
    }
    return drivers.map((descriptor) => ({
      kind: "driver",
      client: node.client,
      leaseName: node.lease.name,
      descriptor,
    }));
  }

  private deviceErrorNodes(leaseName: string, message: string): LeaseTreeNode[] {
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
    const row = model.buildLeaseRow(node.lease);
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

  private pendingItem(node: PendingLeaseNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.pending.label, vscode.TreeItemCollapsibleState.None);
    item.id = `jumpstarter.lease/${node.pending.id}`;
    item.description = describePending(node.pending);
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
    item.id = `jumpstarter.driver/${node.leaseName}/${d.id}`;
    item.description = d.description;
    item.tooltip = d.tooltip;
    item.contextValue = "jumpstarterDriver";
    item.iconPath = new vscode.ThemeIcon("circuit-board");
    return item;
  }

  private commandItem(node: CommandNode): vscode.TreeItem {
    const d = node.descriptor;
    const item = new vscode.TreeItem(d.label, vscode.TreeItemCollapsibleState.None);
    item.id = `jumpstarter.command/${node.leaseName}/${d.cliPath.join("/")}`;
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
