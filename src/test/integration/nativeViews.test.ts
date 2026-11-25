/**
 * Native views: a lease's view as a tab of VS Code's own, through the lease's
 * bridge. Nothing is served: the extension starts `jumpstarter-web bridge`
 * inside the lease and loads the view's page from files.
 */

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { activateWithFakeCli, callsMatching, clearCliCalls, fakeJmpPath, waitFor } from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("native views", () => {
  let api: JumpstarterApi;
  let leaseNode: unknown;
  let errors: string[] = [];
  let restore: () => void = () => {};
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("jumpstarter");

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await config().update("webUi.transport", undefined, vscode.ConfigurationTarget.Global); // the default: the bridge
    await api.refreshAll();
    await waitFor("the lease to appear", async () => {
      for (const node of (await api.trees.leases.getChildren()) ?? []) {
        const item = await api.trees.leases.getTreeItem(node);
        if (String(item.description ?? "").includes("In-Use")) {
          leaseNode = node;
        }
      }
      return leaseNode !== undefined;
    });
    // which drivers have a view is still what the environment's Jumpstarter Web says
    await config().update(
      "webUi.path",
      path.join(path.dirname(fakeJmpPath()), "fake-jumpstarter-web.mjs"),
      vscode.ConfigurationTarget.Global,
    );
    await api.webUi.refreshViews();
    const window = vscode.window as unknown as Record<string, unknown>;
    const original = window.showErrorMessage;
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    restore = () => {
      window.showErrorMessage = original;
    };
  });

  suiteTeardown(async () => {
    api.views.closeAll();
    restore();
    await config().update("webUi.path", undefined, vscode.ConfigurationTarget.Global);
    await config().update("webUi.transport", "server", vscode.ConfigurationTarget.Global);
  });

  setup(() => {
    api.views.stopBridges(); // each test starts the lease's bridge itself
    api.views.closeAll();
    api.webUi.closePanels();
    errors = [];
    clearCliCalls();
  });

  test("a lease's screen opens in a tab of its own, with a bridge in the lease and no server", async () => {
    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
    assert.deepEqual(errors, []);

    const lease = (leaseNode as { lease: { name: string } }).lease.name;
    assert.deepEqual(api.views.keys(), [`${lease}||power|power/meter`]);
    assert.deepEqual(api.webUi.panelLinks(), [], "no framed page of a server");
    assert.equal(api.webUi.serverUrl(lease), undefined, "no server was started");

    const shells = callsMatching("shell");
    assert.equal(shells.length, 1);
    assert.deepEqual(shells[0].slice(0, 6), ["shell", "--client", "fake", "--lease", lease, "--"]);
    assert.deepEqual(shells[0].slice(-3), ["-m", "jumpstarter_web", "bridge"]);
    assert.ok(!shells[0].includes("serve"));

    const html = api.views.html(api.views.keys()[0]) ?? "";
    // the page itself, not a frame of one: its host is set, its files are the webview's, its route is one view
    assert.ok(html.includes("window.__JUMPSTARTER_HOST__"));
    assert.ok(!html.includes("<iframe"));
    assert.ok(/src="https:\/\/[^"]+\/assets\/index\.js"/.test(html), html);
    assert.ok(html.includes(`"route":"/d/power?view=power%2Fmeter%23power&only=power%2Fmeter&chrome=none"`));
    assert.ok(html.includes(`"basePath":""`));
  });

  test("asking again brings the tab forward, and a second view shares the lease's bridge", async () => {
    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
    assert.equal(api.views.keys().length, 1);
    const bridges = callsMatching("shell").filter((argv) => argv.includes("bridge"));
    assert.equal(bridges.length, 1, "one bridge for the lease");
  });

  test("the server is still there for who asks for it", async () => {
    await config().update("webUi.transport", "server", vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
      assert.deepEqual(api.views.keys(), []);
      assert.equal(api.webUi.panelLinks().length, 1);
    } finally {
      api.webUi.stopAll();
      await config().update("webUi.transport", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("an environment with no bridge says what to do", async () => {
    // (a bridge of an earlier test may still be there for its lease: this one must start its own)
    process.env.JMP_FAKE_WEB = "missing";
    try {
      await vscode.commands.executeCommand("jumpstarter.webUi.stop");
      assert.deepEqual(api.views.keys(), [], "a stopped bridge takes its views with it");
      await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", leaseNode);
      assert.deepEqual(api.views.keys(), []);
      assert.match(errors.join("\n"), /has no bridge/);
    } finally {
      delete process.env.JMP_FAKE_WEB;
    }
  });
});
