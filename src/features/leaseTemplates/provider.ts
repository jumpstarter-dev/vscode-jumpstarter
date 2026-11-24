/**
 * TreeDataProvider for the Lease Templates view (view id: jumpstarter.leaseTemplates).
 *
 * Root nodes are the lease templates the active client can request. A
 * template expands into its roles (a star marks an optional one, with how
 * many exporters can be leased for it now), the forwards a lease from it has,
 * and its documentation links. Everything shown comes from the one listing:
 * expanding costs no CLI call.
 */

import * as vscode from "vscode";
import { LeaseForward, LeaseTemplate, LeaseTemplateMember } from "../../types";
import * as model from "./model";

export interface TemplateMessageNode {
  kind: "message";
  text: string;
  icon?: string;
  iconColor?: string;
  tooltip?: string;
  command?: vscode.Command;
}

export interface TemplateNode {
  kind: "template";
  client: string;
  template: LeaseTemplate;
}

export interface TemplateMemberNode {
  kind: "member";
  template: LeaseTemplate;
  entry: LeaseTemplateMember;
}

export interface TemplateForwardNode {
  kind: "forward";
  template: LeaseTemplate;
  forward: LeaseForward;
}

export interface TemplateDocNode {
  kind: "doc";
  template: LeaseTemplate;
  link: string;
  index: number;
}

export type TemplateTreeNode =
  | TemplateMessageNode
  | TemplateNode
  | TemplateMemberNode
  | TemplateForwardNode
  | TemplateDocNode;

type RootState =
  | { kind: "loading" }
  | { kind: "no-client" }
  | { kind: "auth-expired"; client: string }
  /** This `jmp`, or the controller, has no lease templates: not an error. */
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "data"; client: string; templates: LeaseTemplate[] };

const REFRESH = "jumpstarter.leaseTemplates.refresh";

export class LeaseTemplatesTreeProvider implements vscode.TreeDataProvider<TemplateTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TemplateTreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<TemplateTreeNode | undefined> = this.changeEmitter.event;

  private state: RootState = { kind: "loading" };

  /** The client the templates were listed for, when they were. */
  get client(): string | null {
    return this.state.kind === "data" || this.state.kind === "auth-expired" ? this.state.client : null;
  }

  /** The templates currently shown (empty outside the data state). */
  get templates(): readonly LeaseTemplate[] {
    return this.state.kind === "data" ? this.state.templates : [];
  }

  /** Why there are no lease templates to ask for, when this CLI or controller has none. */
  get unavailableReason(): string | undefined {
    return this.state.kind === "unavailable" ? this.state.reason : undefined;
  }

  private set(state: RootState): void {
    this.state = state;
    this.changeEmitter.fire(undefined);
  }

  setTemplates(client: string, templates: LeaseTemplate[]): void {
    this.set({ kind: "data", client, templates });
  }

  setUnavailable(reason: string): void {
    this.set({ kind: "unavailable", reason });
  }

  setNoClient(): void {
    this.set({ kind: "no-client" });
  }

  setAuthExpired(client: string): void {
    this.set({ kind: "auth-expired", client });
  }

  /** Record a refresh failure; the templates already shown are kept. Returns true when the tree shows it. */
  setError(message: string): boolean {
    if (this.state.kind === "data") {
      return false;
    }
    this.set({ kind: "error", message });
    return true;
  }

  getTreeItem(node: TemplateTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "message": {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        if (node.icon) {
          item.iconPath = new vscode.ThemeIcon(
            node.icon,
            node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined,
          );
        }
        item.tooltip = node.tooltip;
        item.command = node.command;
        item.contextValue = "jumpstarterLeaseTemplateMessage";
        return item;
      }
      case "template":
        return rowItem(model.buildTemplateRow(node.template), vscode.TreeItemCollapsibleState.Collapsed);
      case "member":
        return rowItem(model.buildTemplateMemberRow(node.template, node.entry));
      case "forward":
        return rowItem(model.buildTemplateForwardRow(node.template, node.forward));
      case "doc": {
        const item = rowItem(model.buildTemplateDocRow(node.template, node.link, node.index));
        item.command = {
          command: "jumpstarter.leaseTemplates.openDoc",
          title: "Open Documentation",
          arguments: [node],
        };
        return item;
      }
    }
  }

  getChildren(node?: TemplateTreeNode): TemplateTreeNode[] {
    if (!node) {
      return this.rootChildren();
    }
    if (node.kind !== "template") {
      return [];
    }
    const { template } = node;
    return [
      ...template.members.map((entry): TemplateTreeNode => ({ kind: "member", template, entry })),
      ...template.forwards.map((forward): TemplateTreeNode => ({ kind: "forward", template, forward })),
      ...model.docLinks(template).map((link, index): TemplateTreeNode => ({ kind: "doc", template, link, index })),
    ];
  }

  private rootChildren(): TemplateTreeNode[] {
    switch (this.state.kind) {
      case "loading":
        return [{ kind: "message", text: "Loading lease templates…", icon: "loading~spin" }];
      case "no-client":
        return [{ kind: "message", text: "No Jumpstarter client selected", icon: "info" }];
      case "auth-expired":
        return [
          {
            kind: "message",
            text: `Client '${this.state.client}' needs re-authentication`,
            icon: "key",
            iconColor: "errorForeground",
            tooltip: "Re-authenticate from the Clients view, then click to retry.",
            command: { command: REFRESH, title: "Retry" },
          },
        ];
      case "unavailable":
        return [{ kind: "message", text: this.state.reason, icon: "info" }];
      case "error":
        return [
          {
            kind: "message",
            text: this.state.message,
            icon: "warning",
            iconColor: "errorForeground",
            tooltip: "Click to retry.",
            command: { command: REFRESH, title: "Retry" },
          },
        ];
      case "data": {
        const { client, templates } = this.state;
        if (templates.length === 0) {
          return [
            {
              kind: "message",
              text: "No lease templates",
              icon: "info",
              tooltip: "A lab administrator publishes lease templates: sets of exporters that are leased together.",
            },
          ];
        }
        return model.sortTemplates(templates).map((template) => ({ kind: "template", client, template }));
      }
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function rowItem(
  row: model.TemplateRowDescriptor,
  state = vscode.TreeItemCollapsibleState.None,
): vscode.TreeItem {
  const item = new vscode.TreeItem(row.label, state);
  item.id = row.id;
  item.description = row.description;
  item.tooltip = row.tooltip;
  item.contextValue = row.contextValue;
  item.iconPath = new vscode.ThemeIcon(row.icon, row.iconColor ? new vscode.ThemeColor(row.iconColor) : undefined);
  return item;
}
