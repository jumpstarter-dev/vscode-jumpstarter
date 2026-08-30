/**
 * The Administration view and the cluster-write commands: what they render,
 * and what they ask the CLI to do.
 */

import * as assert from "assert";
import { existsSync } from "fs";
import * as vscode from "vscode";
import {
  activateWithFakeCli,
  callsMatching,
  childLabels,
  clearCliCalls,
  expectCall,
  stubUi,
  treeLabels,
  waitFor,
} from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("administration", () => {
  let api: JumpstarterApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
  });

  test("the namespace follows the current client's config", async () => {
    await waitFor("the admin view to load", async () =>
      (await treeLabels(api.trees.admin)).includes("Clients"),
    );
    // The fake client's config says namespace "lab", so that is what is read.
    const call = expectCall("admin", "get", "client");
    assert.deepEqual(call.slice(3), ["-n", "lab", "-o", "json"]);
  });

  test("the cluster's resources are grouped by kind", async () => {
    const categories = await treeLabels(api.trees.admin);
    assert.deepEqual(categories, ["Clients", "Exporters", "Exporter Sets", "Leases"]);

    // Every client in the namespace, not just the one this machine has.
    assert.deepEqual(await childLabels(api.trees.admin, "Clients"), ["fake", "no-credentials"]);
    // Ended leases are hidden until asked for.
    assert.deepEqual(await childLabels(api.trees.admin, "Leases"), ["bench-1"]);
  });

  test("toggling ended leases shows the history", async () => {
    await vscode.commands.executeCommand("jumpstarter.admin.toggleEndedLeases");
    const withEnded = await childLabels(api.trees.admin, "Leases");
    assert.equal(withEnded.length, 2, withEnded.join(", "));
    await vscode.commands.executeCommand("jumpstarter.admin.toggleEndedLeases");
  });

  test("importing a client config asks the CLI for it non-interactively", async () => {
    clearCliCalls();
    const restore = stubUi({
      // Which client, then which driver packages it may load.
      quickPicks: ["fake", "Allow none for now"],
    });
    try {
      await vscode.commands.executeCommand("jumpstarter.importClientConfig");
    } finally {
      restore();
    }

    const call = expectCall("admin", "import", "client", "fake");
    // Never prompt (it would hang on a pipe), and print only the path written.
    assert.ok(call.includes("--nointeractive"), call.join(" "));
    assert.deepEqual(call.slice(-2), ["-o", "path"]);
    // The config the CLI wrote is opened for editing.
    await waitFor("the imported config to open", () =>
      vscode.window.visibleTextEditors.some((editor) =>
        editor.document.uri.fsPath.endsWith("fake.yaml"),
      ),
    );
  });

  test("applying a manifest sends the file to the cluster", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "yaml",
      content: "apiVersion: jumpstarter.dev/v1alpha1\nkind: Client\nmetadata:\n  name: drafted\n",
    });
    const editor = await vscode.window.showTextDocument(document);
    clearCliCalls();

    // Untitled documents have to be saved before the CLI can read them.
    const target = vscode.Uri.file(
      `${require("os").tmpdir()}/jumpstarter-apply-test.yaml`,
    );
    await vscode.workspace.fs.writeFile(target, Buffer.from(document.getText(), "utf8"));
    const saved = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(saved);

    const restore = stubUi({ messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.applyManifest", target);
    } finally {
      restore();
      void editor;
    }

    const call = expectCall("admin", "apply");
    assert.ok(call.includes("-f"), call.join(" "));
    assert.ok(call.includes(target.fsPath), call.join(" "));
    assert.ok(!call.includes("--dry-run"), "apply must not be a dry run");
  });

  test("validating a manifest is a dry run and changes nothing", async () => {
    const target = vscode.Uri.file(`${require("os").tmpdir()}/jumpstarter-apply-test.yaml`);
    assert.ok(existsSync(target.fsPath));
    clearCliCalls();

    const restore = stubUi({ messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.validateManifest", target);
    } finally {
      restore();
    }

    const call = expectCall("admin", "apply");
    assert.ok(call.includes("--dry-run"), call.join(" "));
  });

  test("importing an exporter config asks for that exporter", async () => {
    clearCliCalls();
    const restore = stubUi({ quickPicks: ["bench-1"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.importExporterConfig");
    } finally {
      restore();
    }
    const call = expectCall("admin", "import", "exporter", "bench-1");
    // Driver access is a client config's concern; an exporter has none.
    assert.ok(!call.includes("-a"), call.join(" "));
    assert.ok(!call.includes("--unsafe"), call.join(" "));
  });

  test("the namespace can be pinned, and everything is re-read in it", async () => {
    const restore = stubUi({ inputs: ["other-namespace"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.admin.setNamespace");
    } finally {
      restore();
    }
    try {
      await waitFor("a listing in the chosen namespace", () =>
        callsMatching("admin", "get", "client").some(
          (argv) => argv[argv.indexOf("-n") + 1] === "other-namespace",
        ),
      );
    } finally {
      // Back to following the current client, for the tests after this one.
      await vscode.workspace
        .getConfiguration("jumpstarter.admin")
        .update("namespace", "", vscode.ConfigurationTarget.Global);
      await api.refreshAll();
    }
  });

  test("a new resource is drafted as YAML and nothing is sent until it is applied", async () => {
    clearCliCalls();
    const restore = stubUi({
      quickPicks: ["Client"],
      // name, namespace, then one label, then an empty answer to finish.
      inputs: ["drafted", "lab", "team=platform", ""],
      messages: [undefined],
    });
    try {
      await vscode.commands.executeCommand("jumpstarter.admin.newResource");
    } finally {
      restore();
    }

    await waitFor("the draft to open", () =>
      vscode.window.visibleTextEditors.some((editor) =>
        editor.document.uri.fsPath.endsWith("client-drafted.yaml"),
      ),
    );
    const editor = vscode.window.visibleTextEditors.find((e) =>
      e.document.uri.fsPath.endsWith("client-drafted.yaml"),
    );
    assert.ok(editor);
    const text = editor.document.getText();
    assert.match(text, /kind: Client/);
    assert.match(text, /name: drafted/);
    assert.match(text, /namespace: lab/);
    assert.match(text, /team: platform/);
    // Drafting must not touch the cluster: that is what the apply is for.
    assert.deepEqual(callsMatching("admin", "apply"), []);

    // And the draft it wrote is what apply then sends.
    clearCliCalls();
    const restoreApply = stubUi({ messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.applyManifest", editor.document.uri);
    } finally {
      restoreApply();
    }
    assert.ok(expectCall("admin", "apply").includes(editor.document.uri.fsPath));
  });

  test("a file that is not a Jumpstarter manifest is refused before the CLI runs", async () => {
    const target = vscode.Uri.file(`${require("os").tmpdir()}/jumpstarter-not-a-manifest.yaml`);
    await vscode.workspace.fs.writeFile(
      target,
      Buffer.from("apiVersion: apps/v1\nkind: Deployment\n", "utf8"),
    );
    clearCliCalls();

    const restore = stubUi({ messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.applyManifest", target);
    } finally {
      restore();
    }

    assert.deepEqual(
      expectCallSafe("admin", "apply"),
      undefined,
      "nothing should reach the cluster",
    );
  });
});

/** expectCall's counterpart: the call, or undefined when it never happened. */
function expectCallSafe(...tokens: string[]): string[] | undefined {
  try {
    return expectCall(...tokens);
  } catch {
    return undefined;
  }
}
