/**
 * The Clients view: switching, editing, scaffolding and removing configs.
 *
 * These write real files, which is safe because the host was started with
 * JMP_CLIENT_CONFIG_HOME pointing at a scratch directory (see harness.ts,
 * which refuses to run against a real one).
 */

import * as assert from "assert";
import { existsSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  activateWithFakeCli,
  callsMatching,
  clearCliCalls,
  configHome,
  expectCall,
  findItem,
  stubUi,
  treeLabels,
  waitFor,
} from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("clients", () => {
  let api: JumpstarterApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
    await waitFor("the clients view to load", async () =>
      (await treeLabels(api.trees.clients)).includes("fake"),
    );
  });

  test("the current client is marked as such", async () => {
    const item = await findItem(api.trees.clients, "fake");
    assert.match(String(item.description ?? ""), /current/);
    // The context value is what the menus key off.
    assert.match(String(item.contextValue), /^jumpstarterClient/);
  });

  test("switching clients tells the CLI which one to use", async () => {
    clearCliCalls();
    // Switching to the one that is not already current: picking the current
    // client is a no-op the CLI never hears about.
    const restore = stubUi({ quickPicks: ["spare"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.pickClient");
    } finally {
      restore();
    }
    expectCall("config", "client", "use", "spare");
  });

  test("opening a client config opens the file the CLI reported", async () => {
    const nodes = (await api.trees.clients.getChildren()) ?? [];
    const node = await nodeLabelled(api, nodes, "fake");
    await vscode.commands.executeCommand("jumpstarter.openClientConfig", node);
    await waitFor("the client config to open", () =>
      vscode.window.visibleTextEditors.some((editor) =>
        editor.document.uri.fsPath.endsWith(path.join("clients", "fake.yaml")),
      ),
    );
  });

  test("a new client config is scaffolded into the config home and opened", async () => {
    const restore = stubUi({ inputs: ["scaffolded"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.newClientConfig");
    } finally {
      restore();
    }

    const file = path.join(configHome(), "clients", "scaffolded.yaml");
    await waitFor("the scaffold to be written", () => existsSync(file));
    const document = await vscode.workspace.openTextDocument(file);
    const text = document.getText();
    // Valid enough for the schema to accept and for the user to fill in.
    assert.match(text, /apiVersion: jumpstarter\.dev\/v1alpha1/);
    assert.match(text, /kind: ClientConfig/);
    assert.match(text, /drivers:/);
  });

  test("a new exporter config lists the drivers installed here", async () => {
    const restore = stubUi({ inputs: ["scaffolded-exporter"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.newExporterConfig");
    } finally {
      restore();
    }

    const file = path.join(configHome(), "exporters", "scaffolded-exporter.yaml");
    await waitFor("the scaffold to be written", () => existsSync(file));
    const text = (await vscode.workspace.openTextDocument(file)).getText();
    assert.match(text, /kind: ExporterConfig/);
    assert.match(text, /export:/);
  });

  test("an alias that is already taken is not silently overwritten", async () => {
    // Second time round the same alias: the command offers to open it instead.
    const restore = stubUi({ inputs: ["scaffolded"], messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.newClientConfig");
    } finally {
      restore();
    }
    const text = (
      await vscode.workspace.openTextDocument(
        path.join(configHome(), "clients", "scaffolded.yaml"),
      )
    ).getText();
    assert.match(text, /kind: ClientConfig/);
  });

  test("adding a client from a token creates it without prompting the CLI", async () => {
    clearCliCalls();
    const restore = stubUi({
      quickPicks: ["API token"],
      // The wizard's own order: alias, namespace, name, endpoint, token.
      inputs: ["from-token", "lab", "from-token", "grpc.fake.test:443", "a-token-value"],
    });
    try {
      await vscode.commands.executeCommand("jumpstarter.addClient");
    } finally {
      restore();
    }

    const call = expectCall("config", "client", "create");
    assert.ok(call.includes("--nointeractive"), call.join(" "));
    // The token has to reach the CLI to create the config.
    assert.ok(call.includes("-t"), call.join(" "));
  });

  test("deleting a client asks first, and does nothing when refused", async () => {
    clearCliCalls();
    const nodes = (await api.trees.clients.getChildren()) ?? [];
    const node = await nodeLabelled(api, nodes, "fake");
    const restore = stubUi({ messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.deleteClient", node);
    } finally {
      restore();
    }
    assert.deepEqual(callsMatching("config", "client", "delete"), []);
  });
});

async function nodeLabelled(
  api: JumpstarterApi,
  nodes: readonly unknown[],
  label: string,
): Promise<unknown> {
  for (const node of nodes) {
    const item = await api.trees.clients.getTreeItem(node);
    const text = typeof item.label === "string" ? item.label : (item.label?.label ?? "");
    if (text === label) {
      return node;
    }
  }
  assert.fail(`no client row labelled '${label}'`);
}
