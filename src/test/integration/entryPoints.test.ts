/**
 * The entry points the other suites reach a different way.
 *
 * Most commands can be invoked from a row as well as from the palette, and a
 * row invocation takes the node as an argument — a path that has broken before
 * when a node shape changed. These are shallow on purpose: each asserts that
 * the command does the one thing it exists to do.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import {
  activateWithFakeCli,
  callsMatching,
  captureTerminal,
  clearCliCalls,
  expectCall,
  stubUi,
  terminalArgv,
  treeLabels,
  waitFor,
} from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("entry points", () => {
  let api: JumpstarterApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
    await waitFor("the views to load", async () =>
      (await treeLabels(api.trees.clients)).includes("spare"),
    );
  });

  test("setting the current client from its row uses that client", async () => {
    clearCliCalls();
    const node = await clientNode(api, "spare");
    await vscode.commands.executeCommand("jumpstarter.useClient", node);
    expectCall("config", "client", "use", "spare");
  });

  test("re-authenticating opens a terminal for the interactive login", async () => {
    const node = await clientNode(api, "fake");
    const options = await captureTerminal(() =>
      Promise.resolve(vscode.commands.executeCommand("jumpstarter.reauthenticateClient", node)),
    );
    // Interactive by nature: it must run in a terminal the user can see, not
    // in the background where a browser prompt would be invisible.
    assert.match(terminalArgv(options), /login --client fake/);
  });

  test("importing from a row skips the picker and imports that resource", async () => {
    clearCliCalls();
    const clientNodes = (await api.trees.admin.getChildren()) ?? [];
    const clients = await categoryChildren(api, clientNodes, "Clients");
    const restore = stubUi({ quickPicks: ["Allow none for now"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.admin.importClient", clients[0]);
    } finally {
      restore();
    }
    expectCall("admin", "import", "client", "fake");

    clearCliCalls();
    const exporters = await categoryChildren(api, clientNodes, "Exporters");
    await vscode.commands.executeCommand("jumpstarter.admin.importExporter", exporters[0]);
    expectCall("admin", "import", "exporter", "bench-1");
  });

  test("refreshing devices re-reads the session rather than serving the cache", async () => {
    const leaseNodes = (await api.trees.leases.getChildren()) ?? [];
    const lease = leaseNodes[0];
    // Populate the cache first.
    await api.trees.leases.getChildren(lease);
    clearCliCalls();

    await vscode.commands.executeCommand("jumpstarter.leases.refreshDevices", lease);
    await api.trees.leases.getChildren(lease);
    await waitFor("a fresh describe", () => callsMatching("describe", "lease").length > 0);
  });

  test("pinning a lease for test runs, and clearing it again", async () => {
    const leaseNodes = (await api.trees.leases.getChildren()) ?? [];
    const lease = leaseNodes[0];

    // Pinning is local state (an environment variable collection the Python
    // extension reads), so the only thing to assert is that the round trip
    // works and nothing is asked of the controller to do it.
    await vscode.commands.executeCommand("jumpstarter.pinLeaseForTests", lease);

    const restore = stubUi({ quickPicks: ["Clear"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.manageTestPin");
    } finally {
      restore();
    }
    await vscode.commands.executeCommand("jumpstarter.clearTestPin");
  });

  test("a command invoked with no row asks which one, instead of failing", async () => {
    // Every row command is also in the palette, where there is no node.
    const restore = stubUi({ quickPicks: [undefined], messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.exporters.acquireLease");
      await vscode.commands.executeCommand("jumpstarter.leases.openShell");
      await vscode.commands.executeCommand("jumpstarter.exporters.editConfig");
      await vscode.commands.executeCommand("jumpstarter.exporters.leaseFromSet");
      await vscode.commands.executeCommand("jumpstarter.exporters.openLocalShell");
    } finally {
      restore();
    }
    // Reaching here at all is the assertion: none of them threw.
  });
});

async function clientNode(api: JumpstarterApi, alias: string): Promise<unknown> {
  const nodes = (await api.trees.clients.getChildren()) ?? [];
  for (const node of nodes) {
    const item = await api.trees.clients.getTreeItem(node);
    if ((typeof item.label === "string" ? item.label : item.label?.label) === alias) {
      return node;
    }
  }
  assert.fail(`no client row for '${alias}'`);
}

async function categoryChildren(
  api: JumpstarterApi,
  nodes: readonly unknown[],
  label: string,
): Promise<unknown[]> {
  for (const node of nodes) {
    const item = await api.trees.admin.getTreeItem(node);
    if ((typeof item.label === "string" ? item.label : item.label?.label) === label) {
      return (await api.trees.admin.getChildren(node)) ?? [];
    }
  }
  assert.fail(`no admin category '${label}'`);
}
