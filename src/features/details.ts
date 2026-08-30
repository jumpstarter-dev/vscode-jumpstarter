/**
 * Details pane — a webview at the bottom of the Jumpstarter container that
 * shows the currently selected client, exporter or lease.
 *
 * The tree features push their selection here via the
 * `jumpstarter.details.show` command, so this module owns no polling and
 * issues no CLI calls: it renders objects the trees already fetched.
 */

import * as vscode from "vscode";

import { DetailsSelection, renderDetailsHtml } from "./details/render";

export const SHOW_DETAILS_COMMAND = "jumpstarter.details.show";

class DetailsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private selection: DetailsSelection | null = null;
  private expanded = false;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: false };
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    this.render();
  }

  show(selection: DetailsSelection | null): void {
    this.selection = selection;
    this.render();
    // The view ships collapsed; expand it the first time there is something to
    // show, then leave it under the user's control.
    if (selection && !this.expanded) {
      this.expanded = true;
      void vscode.commands.executeCommand("jumpstarter.details.focus", {
        preserveFocus: true,
      });
    }
  }

  private render(): void {
    if (this.view) {
      this.view.webview.html = renderDetailsHtml(this.selection);
    }
  }
}

/** Push a selection into the details pane; safe to call before it is resolved. */
export function showDetails(selection: DetailsSelection | null): void {
  void vscode.commands.executeCommand(SHOW_DETAILS_COMMAND, selection);
}

export function registerDetails(context: vscode.ExtensionContext): void {
  const provider = new DetailsViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("jumpstarter.details", provider),
    vscode.commands.registerCommand(SHOW_DETAILS_COMMAND, (selection?: DetailsSelection) => {
      provider.show(selection ?? null);
    }),
  );
}
