/**
 * StatusBarManager — status bar item showing the active Jumpstarter client
 * and its auth state. Minimal wiring; the clients feature refines behavior
 * (e.g. registering a picker command).
 */

import * as vscode from "vscode";
import { JmpService, JmpError } from "./jmpService";
import { AuthStatusValue } from "../types";

function authIcon(status: AuthStatusValue): string {
  switch (status) {
    case "valid":
    case "no-expiry":
      return "$(pass)";
    case "expiring-soon":
      return "$(warning)";
    case "expired":
    case "no-token":
    case "invalid-token":
      return "$(error)";
  }
}

export class StatusBarManager implements vscode.Disposable {
  /** The underlying status bar item (left, priority 90). */
  readonly item: vscode.StatusBarItem;

  private refreshing = false;

  constructor(private readonly jmp: JmpService) {
    this.item = vscode.window.createStatusBarItem(
      "jumpstarter.status",
      vscode.StatusBarAlignment.Left,
      90,
    );
    this.item.name = "Jumpstarter";
    this.item.command = "jumpstarter.clients.focus";
    this.item.text = "$(zap) Jumpstarter";
    this.item.tooltip = "Jumpstarter";
    this.item.show();
  }

  /**
   * Re-read the current client and its auth status and repaint the item.
   * Never throws; overlapping calls coalesce.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      await this.doRefresh();
    } catch (err) {
      const msg = err instanceof JmpError ? `${err.kind}: ${err.message}` : String(err);
      this.item.text = "$(zap) Jumpstarter $(warning)";
      this.item.tooltip = `Jumpstarter: ${msg}`;
      this.item.backgroundColor = undefined;
    } finally {
      this.refreshing = false;
    }
  }

  private async doRefresh(): Promise<void> {
    const availability = this.jmp.getAvailability();
    if (availability && availability.kind !== "ok") {
      const label =
        availability.kind === "no-python"
          ? "no Python interpreter"
          : availability.kind === "no-jmp-in-env"
            ? "jumpstarter-cli not installed in the active environment"
            : `jmp error: ${availability.error.message}`;
      this.item.text = "$(zap) Jumpstarter $(warning)";
      this.item.tooltip = `Jumpstarter: ${label}`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }

    const clients = await this.jmp.listClients();
    const current = clients.currentConfig;
    if (!current) {
      this.item.text = "$(zap) No client";
      this.item.tooltip = "Jumpstarter: no client selected";
      this.item.backgroundColor = undefined;
      return;
    }

    const caps = availability?.kind === "ok" ? availability.capabilities : undefined;
    if (caps && !caps.authStatus) {
      this.item.text = `$(zap) ${current}`;
      this.item.tooltip = `Jumpstarter client: ${current}`;
      this.item.backgroundColor = undefined;
      return;
    }

    const auth = await this.jmp.authStatus(current);
    this.item.text = `$(zap) ${current} ${authIcon(auth.status)}`;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Jumpstarter client:** ${current}`,
        `**Auth:** ${auth.status}`,
        auth.expiresAt ? `**Expires:** ${auth.expiresAt}` : undefined,
      ]
        .filter((l): l is string => l !== undefined)
        .join("\n\n"),
    );
    const bad =
      auth.status === "expired" || auth.status === "no-token" || auth.status === "invalid-token";
    this.item.backgroundColor = bad
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
