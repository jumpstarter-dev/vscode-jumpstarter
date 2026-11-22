/**
 * The Web UI commands against a real lease: a real `jmp`, a real
 * `jumpstarter-web`, a real exporter. See .vscode-test.real.mjs.
 *
 * Only the last step is replaced: the link is captured instead of shown, and
 * then fetched, so the run proves the server the link points at is up, is the
 * lease's, and has the drivers the tree offered a view for.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import type { JumpstarterApi } from "../../extension";

const EXTENSION_ID = "jumpstarter.vscode-jumpstarter";

async function waitFor<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

suite("web UI, for real", () => {
  let api: JumpstarterApi;
  let leaseNode: unknown;
  const panels: string[] = [];
  const errors: string[] = [];
  let restore: () => void = () => {};

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration("jumpstarter");
    await config.update("jmpPath", process.env.JMP_REAL_JMP, vscode.ConfigurationTarget.Global);
    await config.update("experimentalCliFeatures", true, vscode.ConfigurationTarget.Global);
    await config.update("pollIntervalSeconds", 3600, vscode.ConfigurationTarget.Global);

    const extension = vscode.extensions.getExtension<JumpstarterApi>(EXTENSION_ID);
    assert.ok(extension, "the extension is not installed in the host");
    api = await extension.activate();
    await vscode.commands.executeCommand("jumpstarter.refresh");
    await api.webUi.refreshViews();

    leaseNode = await waitFor("an In-Use lease of the current client", async () => {
      await vscode.commands.executeCommand("jumpstarter.leases.refresh");
      for (const node of (await api.trees.leases.getChildren()) ?? []) {
        const item = await api.trees.leases.getTreeItem(node);
        if (String(item.description ?? "").includes("In-Use")) {
          return node;
        }
      }
      return undefined;
    });

    const window = vscode.window as unknown as Record<string, unknown>;
    const commands = vscode.commands as unknown as Record<string, unknown>;
    const original = { showErrorMessage: window.showErrorMessage, executeCommand: commands.executeCommand };
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    commands.executeCommand = (command: string, ...args: unknown[]) => {
      if (command === "simpleBrowser.api.open") {
        panels.push(String(args[0]));
        return Promise.resolve();
      }
      return (original.executeCommand as (...a: unknown[]) => Thenable<unknown>).call(vscode.commands, command, ...args);
    };
    restore = () => {
      window.showErrorMessage = original.showErrorMessage;
      commands.executeCommand = original.executeCommand;
    };
  });

  suiteTeardown(() => {
    api?.webUi.stopAll();
    restore();
  });

  test("the lease's drivers with a plugin view offer it, and the view's server answers", async () => {
    const offered: { label: string; node: unknown }[] = [];
    const all: string[] = [];
    for (const node of (await api.trees.leases.getChildren(leaseNode)) ?? []) {
      const item = await api.trees.leases.getTreeItem(node);
      all.push(`${String(item.label)} (${String(item.description)}) ${item.contextValue}`);
      if (item.contextValue === "jumpstarterDriver-web") {
        offered.push({ label: String(item.label), node });
      }
    }
    console.log(`drivers:\n  ${all.join("\n  ")}`);
    assert.ok(offered.length > 0, "no driver of this lease has a plugin view");

    for (const { label, node } of offered) {
      panels.length = 0;
      await vscode.commands.executeCommand("jumpstarter.leases.openDriverView", node);
      assert.deepEqual(errors, []);
      assert.equal(panels.length, 1, `${label}: one panel`);
      console.log(`link for ${label}: ${panels[0]}`);
    }

    // The page and its API, as the panel would load them.
    const base = panels[0].split("#")[0];
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root"|<script/);
    for (const route of ["api/v1/info", "api/v1/drivers", "api/v1/plugins"]) {
      const response = await fetch(new URL(route, base));
      console.log(`GET ${route} -> ${response.status}`);
      assert.equal(response.status, 200, route);
    }
  });

  test("the lease's screen and tools open narrowed", async () => {
    panels.length = 0;
    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
    assert.deepEqual(errors, []);
    assert.match(panels[0], /#\/d\/\?only=hmi,appium-inspector&chrome=minimal$/);
    console.log(`link for the lease: ${panels[0]}`);
  });

  test("VS Code's own browser shows the link in a panel beside the editor", async () => {
    panels.length = 0;
    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
    const link = panels[0];
    const before = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
    restore(); // from here on, for real
    restore = () => {};
    await vscode.commands.executeCommand("simpleBrowser.api.open", link, {
      viewColumn: vscode.ViewColumn.Beside,
    });
    const tab = await waitFor("a browser tab", async () => {
      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
      return tabs.length > before ? tabs[tabs.length - 1] : undefined;
    }, 20_000);
    const input = tab.input as { viewType?: string } | undefined;
    console.log(`tab: "${tab.label}" in column ${tab.group.viewColumn}, input ${input?.constructor?.name} ${input?.viewType ?? ""}`);
    // Give the page a moment to load and name the tab.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    console.log(`tab after load: "${tab.label}"`);
  });

  // For looking at it: JMP_REAL_SHOW=hmi,appium opens those drivers' views for real and keeps the window up
  // for JMP_REAL_HOLD seconds; JMP_REAL_THEME picks the colour theme the window has meanwhile.
  test("show driver views and hold the window", async function () {
    const show = (process.env.JMP_REAL_SHOW ?? "").split(",").filter((name) => name.length > 0);
    if (show.length === 0) {
      this.skip();
    }
    this.timeout(600_000);
    restore();
    restore = () => {};
    if (process.env.JMP_REAL_THEME) {
      await vscode.workspace
        .getConfiguration("workbench")
        .update("colorTheme", process.env.JMP_REAL_THEME, vscode.ConfigurationTarget.Global);
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.view.extension.jumpstarter");
    for (const node of (await api.trees.leases.getChildren(leaseNode)) ?? []) {
      const item = await api.trees.leases.getTreeItem(node);
      if (show.includes(String(item.label))) {
        await vscode.commands.executeCommand("jumpstarter.leases.openDriverView", node);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    console.log("holding the window");
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.JMP_REAL_HOLD ?? "60") * 1000));
  });
});
