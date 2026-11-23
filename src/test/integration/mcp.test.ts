/**
 * Jumpstarter's MCP server is offered to the editor's agents by the extension
 * itself: nobody writes an mcp.json.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { activateWithFakeCli, fakeJmpPath, waitFor } from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("MCP", () => {
  let api: JumpstarterApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await waitFor("the CLI to be probed", () => Promise.resolve(api.services.jmp.getAvailability()?.kind === "ok"));
  });

  teardown(async () => {
    await vscode.workspace
      .getConfiguration("jumpstarter")
      .update("mcp.enabled", undefined, vscode.ConfigurationTarget.Global);
  });

  test("the server is registered with the editor and runs the jmp of the views", async () => {
    assert.strictEqual(api.mcp.registered, true);
    const servers = await api.mcp.servers();
    assert.strictEqual(servers.length, 1);
    assert.strictEqual(servers[0].label, "Jumpstarter");
    assert.strictEqual(servers[0].command, fakeJmpPath());
    assert.deepStrictEqual(servers[0].args, ["mcp", "serve"]);
    assert.ok(servers[0].version?.startsWith("0.10.0"));
  });

  test("the setting takes it away", async () => {
    await vscode.workspace
      .getConfiguration("jumpstarter")
      .update("mcp.enabled", false, vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(await api.mcp.servers(), []);
  });

  test("the manifest declares the provider and the skills the agents read", () => {
    const manifest = vscode.extensions.all.find((e) => e.packageJSON.name === "vscode-jumpstarter")?.packageJSON;
    assert.deepStrictEqual(manifest.contributes.mcpServerDefinitionProviders, [
      { id: "jumpstarter.mcp", label: "Jumpstarter" },
    ]);
    assert.strictEqual(manifest.contributes.chatSkills.length, 2);
  });
});
