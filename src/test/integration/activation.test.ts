/**
 * The extension activates, contributes everything it declares, and renders
 * each view from what the CLI told it.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import {
  activateWithFakeCli,
  childLabels,
  EXTENSION_ID,
  expectCall,
  findItem,
  iconIdOf,
  treeLabels,
  waitFor,
} from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("activation", () => {
  let api: JumpstarterApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
  });

  test("every contributed command is actually registered", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const declared: string[] = (
      extension.packageJSON.contributes?.commands ?? []
    ).map((c: { command: string }) => c.command);
    assert.ok(declared.length > 20, "expected the extension to contribute commands");

    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter((command) => !registered.has(command));
    assert.deepEqual(missing, [], `commands declared but not registered: ${missing.join(", ")}`);
  });

  test("the CLI is probed through the configured path", () => {
    expectCall("version", "-o", "json");
  });

  test("exporters render, grouped by pool, with the local section last", async () => {
    await api.refreshAll();
    await waitFor("the exporters view to load", async () =>
      (await treeLabels(api.trees.exporters)).includes("bench-1"),
    );

    const labels = await treeLabels(api.trees.exporters);
    // The pool comes first, its member is not repeated at the top level, and
    // the local-only config is under its own section.
    assert.ok(labels.includes("qemu-pool"), labels.join(", "));
    assert.ok(!labels.includes("pool-member-1"), "a pool member must not also be a root row");
    assert.ok(labels.includes("bench-1"));
    assert.ok(labels.includes("bench-offline"));
    assert.equal(labels[labels.length - 1], "Local Exporters");

    assert.deepEqual(await childLabels(api.trees.exporters, "qemu-pool"), ["pool-member-1"]);
    // The registered exporter has a local config too, but belongs in the
    // cluster list; only the one the controller does not know is local.
    assert.deepEqual(await childLabels(api.trees.exporters, "Local Exporters"), ["devbench"]);
  });

  test("an exporter's icon says what state it is in", async () => {
    const available = await findItem(api.trees.exporters, "bench-1");
    assert.equal(iconIdOf(available), "vm-active");

    // Offline is the one state with no codicon, so it renders as a file icon.
    const offline = await findItem(api.trees.exporters, "bench-offline");
    assert.equal(iconIdOf(offline), undefined, "offline should use the bundled circle-x");
    assert.ok(
      String((offline.iconPath as vscode.Uri).path).endsWith("circle-x-red.svg"),
      `unexpected icon ${String(offline.iconPath)}`,
    );
  });

  test("leases render with the client's own leases", async () => {
    await waitFor("the leases view to load", async () =>
      (await treeLabels(api.trees.leases)).some((label) => label.includes("lease-1")),
    );
    expectCall("get", "leases");
  });

  test("clients render from the config list", async () => {
    await waitFor("the clients view to load", async () =>
      (await treeLabels(api.trees.clients)).includes("fake"),
    );
    const item = await findItem(api.trees.clients, "fake");
    // The fake holds an API key. It has an issuer, because the token the
    // controller mints is itself a JWT — which must not make it read as OIDC.
    assert.equal(iconIdOf(item), "key");
  });
});
