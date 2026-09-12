import * as assert from "assert";
import * as vscode from "vscode";
import type { JumpstarterApi } from "../../extension";
import { JmpService } from "../../services/jmpService";
import {
  activateWithFakeCli,
  callsMatching,
  childLabels,
  clearCliCalls,
  cliCalls,
  configHome,
  expectCall,
  stubUi,
  treeLabels,
  waitFor,
} from "./harness";

suite("current-main CLI compatibility", () => {
  let api: JumpstarterApi;

  async function setExperimental(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration("jumpstarter")
      .update("experimentalCliFeatures", enabled, vscode.ConfigurationTarget.Global);
    // Test the configuration listener, not an explicit manual probe.
    await waitFor("capabilities to follow the setting", () => {
      const availability = api.services.jmp.getAvailability();
      return availability?.kind === "ok" && availability.capabilities.adminApply === enabled;
    });
  }

  async function setDriverSchemas(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration("jumpstarter")
      .update("experimentalDriverSchemas", enabled, vscode.ConfigurationTarget.Global);
    await waitFor("driver schemas to follow the setting", () => {
      const availability = api.services.jmp.getAvailability();
      return availability?.kind === "ok" &&
        availability.capabilities.driverSchema === (enabled && availability.capabilities.adminApply);
    });
  }

  suiteSetup(async () => {
    process.env.JMP_FAKE_MAIN_ONLY = "1";
    api = await activateWithFakeCli(false);
    await api.refreshAll();
  });

  suiteTeardown(async () => {
    delete process.env.JMP_FAKE_MAIN_ONLY;
    await setExperimental(true);
    await setDriverSchemas(true);
  });

  test("default-mode polling lists resources without unsupported commands", async () => {
    clearCliCalls();
    await api.refreshAll();
    assert.deepEqual(await treeLabels(api.trees.admin), ["Clients", "Exporters", "Leases"]);
    assert.ok((await treeLabels(api.trees.clients)).length > 0);
    assert.ok((await treeLabels(api.trees.exporters)).length > 0);
    expectCall("auth", "status");
    expectCall("get", "exporters");
    expectCall("get", "leases");
    assert.deepEqual(callsMatching("admin", "get", "exporterset"), []);
    assert.deepEqual(callsMatching("driver", "schema"), []);
  });

  test("expanding a lease explains the requirement without describing drivers", async () => {
    clearCliCalls();
    const nodes = (await api.trees.leases.getChildren()) ?? [];
    const lease = nodes.find((node) => (node as { kind?: string }).kind === "lease");
    assert.ok(lease);
    const children = (await api.trees.leases.getChildren(lease)) ?? [];
    assert.equal(children.length, 1);
    const item = await api.trees.leases.getTreeItem(children[0]);
    assert.match(String(item.label), /integration-branch CLI/);
    assert.deepEqual(callsMatching("describe"), []);
  });

  test("service guards reject every experimental API before spawning jmp", async () => {
    clearCliCalls();
    const jmp = api.services.jmp;
    for (const action of [
      () => jmp.driverSchemas(),
      () => jmp.describeLeaseWithDrivers("fake", "lease-1234"),
      () => jmp.adminExporterSets(),
      () => jmp.adminApply(["unused.yaml"]),
    ]) {
      await assert.rejects(action, /experimentalCliFeatures/);
    }
    assert.deepEqual(cliCalls(), []);
  });

  test("new-resource drafts work on main, with kubectl apply and server-side validation", async () => {
    clearCliCalls();
    const restoreDraft = stubUi({
      quickPicks: ["Client"], inputs: ["main-test", "lab", ""], messages: [undefined],
    });
    try {
      await vscode.commands.executeCommand("jumpstarter.admin.newResource");
    } finally {
      restoreDraft();
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    assert.ok(uri);
    assert.ok(uri.fsPath.endsWith("client-main-test.yaml"));
    assert.deepEqual(callsMatching("kubectl", "apply"), [], "drafting must not apply");
    const restoreApply = stubUi({});
    try {
      await vscode.commands.executeCommand("jumpstarter.applyManifest", uri);
      const apply = expectCall("kubectl", "apply");
      assert.ok(apply.includes(uri.fsPath));
      assert.equal(apply[apply.indexOf("-n") + 1], "lab");
      assert.ok(!apply.includes("--dry-run=server"));
      clearCliCalls();
      await vscode.commands.executeCommand("jumpstarter.validateManifest", uri);
      assert.ok(expectCall("kubectl", "apply").includes("--dry-run=server"));
      assert.deepEqual(callsMatching("admin", "apply"), []);
    } finally {
      restoreApply();
    }
  });

  test("kubectl failures are reported, without retrying through jmp", async () => {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(configHome()), "failed-apply.yaml");
    await vscode.workspace.fs.writeFile(uri, Buffer.from(
      "apiVersion: jumpstarter.dev/v1alpha1\nkind: Client\nmetadata:\n  name: main-test\n",
    ));
    const original = vscode.window.showErrorMessage;
    let message = "";
    vscode.window.showErrorMessage = (async (text: string) => { message = text; }) as typeof original;
    process.env.JMP_FAKE_KUBECTL_FAIL = "1";
    clearCliCalls();
    try {
      await vscode.commands.executeCommand("jumpstarter.applyManifest", uri);
      assert.match(message, /Forbidden/);
      assert.equal(callsMatching("kubectl", "apply").length, 1);
      assert.deepEqual(callsMatching("admin", "apply"), []);
    } finally {
      delete process.env.JMP_FAKE_KUBECTL_FAIL;
      vscode.window.showErrorMessage = original;
    }
  });

  test("client import accepts explicit driver patterns without driver schema", async () => {
    clearCliCalls();
    const restore = stubUi({
      quickPicks: ["fake", "Enter driver packages"],
      inputs: [" jumpstarter_driver_power.*, jumpstarter_driver_serial.* "],
    });
    try {
      await vscode.commands.executeCommand("jumpstarter.importClientConfig");
    } finally {
      restore();
    }
    const call = expectCall("admin", "import", "client", "fake");
    assert.equal(call[call.indexOf("-a") + 1], "jumpstarter_driver_power.*,jumpstarter_driver_serial.*");
    assert.ok(!call.includes("--unsafe"));
    assert.deepEqual(callsMatching("driver", "schema"), []);
  });

  test("canceling manual driver access does not import a restricted config silently", async () => {
    clearCliCalls();
    const restore = stubUi({ quickPicks: ["fake", "Enter driver packages"], inputs: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.importClientConfig");
    } finally {
      restore();
    }
    assert.deepEqual(callsMatching("admin", "import"), []);
  });

  test("driver schema discovery needs its own opt-in and can be disabled live", async () => {
    delete process.env.JMP_FAKE_MAIN_ONLY;
    try {
      assert.equal(vscode.workspace.getConfiguration("jumpstarter")
        .inspect<boolean>("experimentalDriverSchemas")?.defaultValue, false);
      await setExperimental(true);
      await setDriverSchemas(false);
      clearCliCalls();
      await assert.rejects(() => api.services.jmp.driverSchemas(), /experimentalDriverSchemas/);
      assert.deepEqual(callsMatching("driver", "schema"), []);
      assert.equal(api.services.jmp.hasCapability("describeDrivers"), true);
      const restore = stubUi({ quickPicks: ["fake", "Enter driver packages"], inputs: ["jumpstarter_driver_power.*"] });
      try {
        await vscode.commands.executeCommand("jumpstarter.importClientConfig");
      } finally {
        restore();
      }
      assert.deepEqual(callsMatching("driver", "schema"), []);
      expectCall("admin", "import", "client", "fake");
      await setDriverSchemas(true);
      await api.services.jmp.driverSchemas();
      expectCall("driver", "schema");
      await setDriverSchemas(false);
      clearCliCalls();
      await assert.rejects(() => api.services.jmp.driverSchemas(), /experimentalDriverSchemas/);
      assert.deepEqual(callsMatching("driver", "schema"), []);
    } finally {
      await setExperimental(false);
      await setDriverSchemas(false);
      process.env.JMP_FAKE_MAIN_ONLY = "1";
    }
  });

  test("opt-in and opt-out update capabilities and views without a reload", async () => {
    delete process.env.JMP_FAKE_MAIN_ONLY;
    try {
      await setExperimental(true);
      await api.refreshAll();
      expectCall("admin", "get", "exporterset");
      await setDriverSchemas(true);
      await api.services.jmp.driverSchemas();
      assert.ok((await childLabels(api.trees.leases, "lease-1")).length > 0);
      expectCall("describe", "lease");
      // A newly constructed service must still fail closed before its probe.
      const unprobed = new JmpService(api.services.output);
      try {
        await assert.rejects(() => unprobed.driverSchemas(), /experimentalCliFeatures/);
      } finally {
        unprobed.dispose();
      }
    } finally {
      await setExperimental(false);
      process.env.JMP_FAKE_MAIN_ONLY = "1";
      await api.refreshAll();
    }
    clearCliCalls();
    assert.deepEqual(await treeLabels(api.trees.admin), ["Clients", "Exporters", "Leases"]);
    const labels = await childLabels(api.trees.leases, "lease-1");
    assert.match(labels.join(" "), /integration-branch CLI/);
    assert.deepEqual(callsMatching("describe"), []);
  });
});
