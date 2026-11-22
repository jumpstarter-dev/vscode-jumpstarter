/**
 * Opening a lease in Jumpstarter Web: the extension starts one server per
 * lease inside the lease session and hands the browser a deep link to it.
 */

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { activateWithFakeCli, callsMatching, clearCliCalls, fakeJmpPath, waitFor } from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("web UI", () => {
  let api: JumpstarterApi;
  let leaseNode: unknown;
  /** Links handed to the system browser. */
  let opened: string[] = [];
  /** Links shown in a panel beside the editor. */
  let panels: string[] = [];
  let errors: string[] = [];
  let restore: () => void = () => {};

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
    await waitFor("the lease to appear", async () => {
      const nodes = (await api.trees.leases.getChildren()) ?? [];
      for (const node of nodes) {
        const item = await api.trees.leases.getTreeItem(node);
        if (String(item.description ?? "").includes("In-Use")) {
          leaseNode = node;
        }
      }
      return leaseNode !== undefined;
    });

    // The environment's Jumpstarter Web, with a view for the fake's power driver.
    await vscode.workspace
      .getConfiguration("jumpstarter")
      .update(
        "webUi.path",
        path.join(path.dirname(fakeJmpPath()), "fake-jumpstarter-web.mjs"),
        vscode.ConfigurationTarget.Global,
      );
    await api.webUi.refreshViews();

    // Nothing may really open a browser, or a panel, from a test run.
    const env = vscode.env as unknown as Record<string, unknown>;
    const window = vscode.window as unknown as Record<string, unknown>;
    const commands = vscode.commands as unknown as Record<string, unknown>;
    const original = {
      openExternal: env.openExternal,
      showErrorMessage: window.showErrorMessage,
      executeCommand: commands.executeCommand,
    };
    env.openExternal = async (target: unknown) => {
      opened.push(String(target));
      return true;
    };
    commands.executeCommand = (command: string, ...args: unknown[]) => {
      if (command === "simpleBrowser.api.open") {
        panels.push(String(args[0]));
        return Promise.resolve();
      }
      return (original.executeCommand as (...a: unknown[]) => Thenable<unknown>).call(
        vscode.commands,
        command,
        ...args,
      );
    };
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    restore = () => {
      env.openExternal = original.openExternal;
      commands.executeCommand = original.executeCommand;
      window.showErrorMessage = original.showErrorMessage;
    };
  });

  suiteTeardown(async () => {
    api.webUi.stopAll();
    restore();
    await vscode.workspace
      .getConfiguration("jumpstarter")
      .update("webUi.path", undefined, vscode.ConfigurationTarget.Global);
  });

  setup(() => {
    opened = [];
    panels = [];
    errors = [];
    clearCliCalls();
  });

  test("the screen and tools open narrowed, served from inside the lease", async () => {
    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);

    assert.deepEqual(errors, []);
    // Beside the editor, not in a browser window.
    assert.deepEqual(opened, []);
    assert.equal(panels.length, 1);
    assert.match(panels[0], /^http:\/\/127\.0\.0\.1:\d+\/#\/d\/\?only=hmi,appium-inspector&chrome=minimal$/);

    const [argv] = callsMatching("shell");
    const lease = (leaseNode as { lease: { name: string } }).lease.name;
    assert.deepEqual(argv.slice(0, 6), ["shell", "--client", "fake", "--lease", lease, "--"]);
    const serve = argv.slice(argv.indexOf("serve"));
    assert.deepEqual(serve.slice(0, 3), ["serve", "--host", "127.0.0.1"]);
    assert.equal(api.webUi.serverUrl(lease), panels[0].split("#")[0]);
  });

  test("the full workbench reuses the lease's server, in the system browser", async () => {
    await vscode.commands.executeCommand("jumpstarter.leases.openFullWebUi", leaseNode);

    assert.deepEqual(errors, []);
    assert.equal(callsMatching("shell").length, 0);
    assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/#\/d\/$/);
  });

  test("the tools setting decides what the focused link shows", async () => {
    const config = vscode.workspace.getConfiguration("jumpstarter");
    await config.update("webUi.tools", ["hmi/screen"], vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
      assert.match(panels[0], /#\/d\/\?only=hmi%2Fscreen&chrome=minimal$/);
    } finally {
      await config.update("webUi.tools", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("stopping ends the server, and the next open starts another", async () => {
    await vscode.commands.executeCommand("jumpstarter.webUi.stop");
    const lease = (leaseNode as { lease: { name: string } }).lease.name;
    assert.equal(api.webUi.serverUrl(lease), undefined);

    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
    assert.equal(callsMatching("shell").length, 1);
    assert.equal(panels.length, 1);
  });

  test("the setting sends the screen and tools to the system browser instead", async () => {
    const config = vscode.workspace.getConfiguration("jumpstarter");
    await config.update("webUi.openIn", "browser", vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
      assert.deepEqual(panels, []);
      assert.equal(opened.length, 1);
    } finally {
      await config.update("webUi.openIn", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("a driver with a plugin view offers it; one without does not", async () => {
    const items = await driverItems(api, leaseNode);
    assert.equal(items.get("power")?.contextValue, "jumpstarterDriver-web");
    // Its only matching plugin cannot be loaded, so there is nothing to open.
    assert.equal(items.get("storage")?.contextValue, "jumpstarterDriver");
  });

  test("a driver's view opens beside the editor, on that driver alone", async () => {
    const drivers = (await api.trees.leases.getChildren(leaseNode)) ?? [];
    let power: unknown;
    for (const node of drivers) {
      if ((await api.trees.leases.getTreeItem(node)).label === "power") {
        power = node;
      }
    }
    await vscode.commands.executeCommand("jumpstarter.leases.openDriverView", power);

    assert.deepEqual(errors, []);
    assert.equal(panels.length, 1);
    assert.match(
      panels[0],
      /^http:\/\/127\.0\.0\.1:\d+\/#\/d\/power\?view=power%2Fmeter%23power&only=power&chrome=minimal$/,
    );
  });

  test("an environment without Jumpstarter Web says how to get it", async () => {
    api.webUi.stopAll();
    process.env.JMP_FAKE_WEB = "missing";
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
    } finally {
      delete process.env.JMP_FAKE_WEB;
    }
    assert.deepEqual([...opened, ...panels], []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not installed/);
  });
});

async function driverItems(api: JumpstarterApi, leaseNode: unknown): Promise<Map<string, vscode.TreeItem>> {
  const items = new Map<string, vscode.TreeItem>();
  for (const node of (await api.trees.leases.getChildren(leaseNode)) ?? []) {
    const item = await api.trees.leases.getTreeItem(node);
    items.set(String(item.label), item);
  }
  return items;
}
