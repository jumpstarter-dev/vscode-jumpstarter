/**
 * Lease templates: the view that lists them, requesting one, and a CLI or a
 * controller that has none. The fake CLI answers `jmp get lease-templates`
 * with the output of the real one (src/test/fixtures/cli).
 */

import * as assert from "assert";
import * as vscode from "vscode";
import {
  activateWithFakeCli,
  callsMatching,
  clearCliCalls,
  expectCall,
  stubUi,
  treeLabels,
  waitFor,
} from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("lease templates", () => {
  let api: JumpstarterApi;

  const tree = (): vscode.TreeDataProvider<unknown> => api.trees.leaseTemplates;
  const label = (item: vscode.TreeItem): string =>
    typeof item.label === "string" ? item.label : (item.label?.label ?? "");
  const template = async (name: string): Promise<unknown> => {
    for (const node of (await tree().getChildren()) ?? []) {
      if (label(await tree().getTreeItem(node)) === name) {
        return node;
      }
    }
    assert.fail(`no template ${name} in the view`);
  };
  const rows = async (parent?: unknown): Promise<string[]> =>
    Promise.all(
      ((await tree().getChildren(parent)) ?? []).map(async (node) => {
        const item = await tree().getTreeItem(node);
        return `${label(item)} | ${String(item.description ?? "")}`;
      }),
    );

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
    await waitFor("the templates to load", async () => (await treeLabels(tree())).includes("ivi"));
  });

  test("the view lists the templates of the client, with their roles and what can be leased", async () => {
    expectCall("get", "lease-templates");
    assert.deepEqual(await rows(), [
      "bench | headunit, phone*, ecu · 2/3 available · AAOS head unit, phone, and body ECU on one CAN bus",
      "ivi | headunit, phone*, ecu · 2/3 available · AAOS head unit, phone, and body ECU on one CAN bus",
    ]);
    const item = await tree().getTreeItem(await template("ivi"));
    assert.equal(item.contextValue, "jumpstarterLeaseTemplate");
    assert.match(String(item.tooltip), /Set the head unit to on before you start the phone\./);
  });

  test("a template opens into its roles, its forwards and its documentation", async () => {
    assert.deepEqual(await rows(await template("ivi")), [
      "headunit | device-type=aaos-headunit · 2 available",
      "phone* | device-type=phone · 0 available",
      "ecu | exporter ecu-11 · 1 available",
      "bt | headunit.rootcanal, phone.controller",
      "https://wiki.example.com/labs/ivi | ",
    ]);
    // A template without forwards has none to show.
    assert.equal((await rows(await template("bench"))).filter((row) => row.startsWith("bt")).length, 0);
  });

  test("leasing a template asks which optional roles to leave out and for how long", async () => {
    clearCliCalls();
    const restore = stubUi({ quickPicks: ["phone", "4h"], messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.leaseTemplates.lease", await template("ivi"));
    } finally {
      restore();
    }
    const call = expectCall("create", "lease");
    assert.deepEqual(call, [
      "create", "lease", "--client", "fake", "-t", "ivi",
      "--without", "phone",
      "--duration", "4h",
      "--tag", "created-by=vscode",
      "-o", "name",
    ]);
  });

  test("the template's own duration is not sent, and every role is leased when none is left out", async () => {
    clearCliCalls();
    // (an answer that names no role: the roles are all kept)
    const restore = stubUi({ quickPicks: ["(none of them)", "Template default"], messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.leaseTemplates.lease", await template("ivi"));
    } finally {
      restore();
    }
    assert.deepEqual(expectCall("create", "lease"), [
      "create", "lease", "--client", "fake", "-t", "ivi", "--tag", "created-by=vscode", "-o", "name",
    ]);
  });

  test("from the palette the template is chosen first; cancelling asks nothing of the controller", async () => {
    clearCliCalls();
    let restore = stubUi({ quickPicks: ["bench", "(none of them)", "Custom…"], inputs: ["1h30m"], messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.leaseFromTemplate");
    } finally {
      restore();
    }
    const call = expectCall("create", "lease");
    assert.deepEqual(call.slice(4, 8), ["-t", "bench", "--duration", "1h30m"]);

    clearCliCalls();
    restore = stubUi({ quickPicks: ["ivi", undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.leaseFromTemplate");
    } finally {
      restore();
    }
    assert.deepEqual(callsMatching("create", "lease"), []);
  });

  test("a jmp from before lease templates is not an error: the view says so and leasing explains", async () => {
    process.env.JMP_FAKE_NO_TEMPLATES = "1";
    const window = vscode.window as unknown as Record<string, unknown>;
    const original = { info: window.showInformationMessage, error: window.showErrorMessage };
    const said: string[] = [];
    const errors: string[] = [];
    window.showInformationMessage = async (message: string) => {
      said.push(message);
      return undefined;
    };
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    try {
      await vscode.commands.executeCommand("jumpstarter.leaseTemplates.refresh");
      const result = await api.services.jmp.getLeaseTemplates("fake");
      assert.equal(result.kind, "unavailable");
      assert.deepEqual(await rows(), [
        "This jmp has no lease templates (`jmp get lease-templates`): upgrade the Jumpstarter CLI to use them. | ",
      ]);
      clearCliCalls();
      await vscode.commands.executeCommand("jumpstarter.leaseFromTemplate");
      assert.equal(said.length, 1);
      assert.match(said[0], /has no lease templates/);
      assert.deepEqual(callsMatching("create", "lease"), []);
      assert.deepEqual(errors, []);
      // The other views are as they were.
      await api.refreshAll();
      assert.ok((await treeLabels(api.trees.leases)).includes("lease-1"));
      assert.deepEqual(errors, []);
    } finally {
      delete process.env.JMP_FAKE_NO_TEMPLATES;
      window.showInformationMessage = original.info;
      window.showErrorMessage = original.error;
    }
  });

  test("a controller from before lease templates is not an error either", async () => {
    process.env.JMP_FAKE_OLD_CONTROLLER = "1";
    try {
      await vscode.commands.executeCommand("jumpstarter.leaseTemplates.refresh");
      assert.deepEqual(await rows(), ["The controller of this client is too old for lease templates. | "]);
    } finally {
      delete process.env.JMP_FAKE_OLD_CONTROLLER;
    }
    await vscode.commands.executeCommand("jumpstarter.leaseTemplates.refresh");
    assert.deepEqual(await treeLabels(tree()), ["bench", "ivi"]);
  });

  test("another failure is reported as one, and the templates already shown are kept", async () => {
    process.env.JMP_FAKE_FAIL = "get lease-templates";
    try {
      await assert.rejects(() => api.services.jmp.getLeaseTemplates("fake"));
      await vscode.commands.executeCommand("jumpstarter.leaseTemplates.refresh");
      assert.deepEqual(await treeLabels(tree()), ["bench", "ivi"]);
    } finally {
      delete process.env.JMP_FAKE_FAIL;
    }
  });
});
