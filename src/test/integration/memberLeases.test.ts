/**
 * A lease with members (one exporter for each role, from a lease template):
 * what the Leases view shows of it, and that everything that is done "for a
 * lease" works on it. The fake CLI answers with the output of the real one
 * (src/test/fixtures/cli).
 */

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  activateWithFakeCli,
  callsMatching,
  captureTerminal,
  clearCliCalls,
  expectCall,
  fakeJmpPath,
  stubUi,
  terminalArgv,
  waitFor,
} from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("leases with members", () => {
  let api: JumpstarterApi;
  /** Links handed to the system browser. */
  let opened: string[] = [];
  let errors: string[] = [];
  let restore: () => void = () => {};

  const tree = (): vscode.TreeDataProvider<unknown> => api.trees.leases;
  const item = async (node: unknown): Promise<vscode.TreeItem> => tree().getTreeItem(node);
  const label = (treeItem: vscode.TreeItem): string =>
    typeof treeItem.label === "string" ? treeItem.label : (treeItem.label?.label ?? "");
  const childrenOf = async (node?: unknown): Promise<unknown[]> => (await tree().getChildren(node)) ?? [];
  const child = async (parent: unknown, wanted: string): Promise<unknown> => {
    for (const node of await childrenOf(parent)) {
      if (label(await item(node)) === wanted) {
        return node;
      }
    }
    assert.fail(`no row labelled '${wanted}'`);
  };
  const rows = async (parent?: unknown): Promise<string[]> =>
    Promise.all(
      (await childrenOf(parent)).map(async (node) => {
        const treeItem = await item(node);
        return `${label(treeItem)} | ${String(treeItem.description ?? "")}`;
      }),
    );
  /** A lease's row, by the lease's name. */
  const leaseNode = async (name: string): Promise<unknown> => {
    for (const node of await childrenOf()) {
      if ((node as { lease?: { name?: string } }).lease?.name === name) {
        return node;
      }
    }
    assert.fail(`no lease ${name} in the view`);
  };

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    process.env.JMP_FAKE_MEMBERS = "1";
    await api.refreshAll();
    await waitFor("the leases with members to appear", async () =>
      (await childrenOf()).some((node) => (node as { lease?: { name?: string } }).lease?.name === "lease-9m2qd"),
    );

    // The environment's Jumpstarter Web, with a view for the power driver of each role.
    await vscode.workspace
      .getConfiguration("jumpstarter")
      .update(
        "webUi.path",
        path.join(path.dirname(fakeJmpPath()), "fake-jumpstarter-web.mjs"),
        vscode.ConfigurationTarget.Global,
      );
    await api.webUi.refreshViews();

    // Nothing may really open a browser from a test run.
    const env = vscode.env as unknown as Record<string, unknown>;
    const window = vscode.window as unknown as Record<string, unknown>;
    const original = { openExternal: env.openExternal, showErrorMessage: window.showErrorMessage };
    env.openExternal = async (target: unknown) => {
      opened.push(String(target));
      return true;
    };
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    restore = () => {
      env.openExternal = original.openExternal;
      window.showErrorMessage = original.showErrorMessage;
    };
  });

  suiteTeardown(async () => {
    api.webUi.stopAll();
    restore();
    delete process.env.JMP_FAKE_MEMBERS;
    await vscode.workspace
      .getConfiguration("jumpstarter")
      .update("webUi.path", undefined, vscode.ConfigurationTarget.Global);
    // The suites after this one are about the one lease of one exporter.
    await api.refreshAll();
  });

  setup(() => {
    opened = [];
    errors = [];
    api.webUi.closePanels();
  });

  test("each lease has a row that says what it holds; a lease of one exporter is as it was", async () => {
    const all = await rows();
    assert.deepEqual(all.slice(1), [
      "lease-9m2qd | ivi · In-Use",
      "lease-degraded | phone, headunit · Degraded",
      "lease-omitted | ivi · In-Use",
      "lease-scalar | In-Use",
      "lease-pending | phone, headunit · Waiting",
    ]);
    // (the first lease has a start time, so its row also counts down: only its beginning is fixed)
    assert.match(all[0], /^lease-1 \| bench-1 · In-Use/);
    for (const row of all) {
      assert.doesNotMatch(row, /undefined|null/);
    }
    // A lease with members takes the actions of a lease in use: the menus match the start of this value.
    assert.match(String((await item(await leaseNode("lease-9m2qd"))).contextValue), /^jumpstarterLease-inUse.*-members$/);
    assert.match(String((await item(await leaseNode("lease-degraded"))).contextValue), /^jumpstarterLease-inUse/);
    assert.equal((await item(await leaseNode("lease-1"))).contextValue, "jumpstarterLease-inUse-vscode");
  });

  test("a lease with members opens into its roles and its forwards, with the direction of each forward", async () => {
    const lease = await leaseNode("lease-9m2qd");
    assert.deepEqual(await rows(lease), [
      "phone | rack3-phone-4 · Bound · optional",
      "headunit | rack3-hu-2 · Bound",
      "bt | headunit.rootcanal → phone.controller · Connected",
    ]);
    // The arrow is from the ports the exporters declare.
    const ports = expectCall("get", "exporters");
    assert.ok(callsMatching("get", "exporters").some((argv) => argv.includes("ports")), ports.join(" "));
    const forward = await item(await child(lease, "bt"));
    assert.match(String(forward.tooltip), /headunit: Connected/);
    assert.match(String(forward.tooltip), /phone: Connected/);
    // Nothing of this needs the lease's session: the roles are in the listing.
    assert.equal(callsMatching("describe", "lease").filter((argv) => argv.includes("lease-9m2qd")).length, 0);
  });

  test("a degraded lease says which role is lost and why, and what became of its forward", async () => {
    const lease = await leaseNode("lease-degraded");
    assert.deepEqual(await rows(lease), [
      "Degraded: phone (ExporterOffline) lost its exporter | ",
      "phone | Lost: ExporterOffline · was rack3-phone-4 · optional",
      "headunit | rack3-hu-2 · Bound",
      // (the exporter the lost role had still says which way its port goes)
      "bt | headunit.rootcanal → phone.controller · Failed: member phone is lost",
    ]);
    const lost = await item(await child(lease, "phone"));
    assert.equal(lost.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(lost.contextValue, "jumpstarterRole-lost");
    // The role that still has its exporter still opens.
    const bound = await item(await child(lease, "headunit"));
    assert.equal(bound.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  });

  test("a role that was left out, and a lease that is still waiting", async () => {
    assert.deepEqual(await rows(await leaseNode("lease-omitted")), [
      "phone | Omitted: Excluded · optional",
      "headunit | rack3-hu-2 · Bound",
      "bt | headunit.rootcanal, phone.controller · Disabled: the member phone is left out",
    ]);
    const waiting = await leaseNode("lease-pending");
    assert.deepEqual(await rows(waiting), ["phone | Pending · optional", "headunit | Pending"]);
    assert.equal(
      (await item(await child(waiting, "headunit"))).collapsibleState,
      vscode.TreeItemCollapsibleState.None,
    );
  });

  test("a bound role opens into its own drivers, read once for all the roles of the lease", async () => {
    const lease = await leaseNode("lease-9m2qd");
    await vscode.commands.executeCommand("jumpstarter.leases.refreshDevices", lease);
    clearCliCalls();
    const phone = await child(lease, "phone");
    assert.deepEqual(await rows(phone), ["power | PowerClient"]);
    const headunit = await child(lease, "headunit");
    assert.deepEqual(await rows(headunit), ["power | PowerClient"]);

    // One session for the lease, by its name, and the drivers of every role from it.
    const sessions = callsMatching("shell");
    assert.equal(sessions.length, 1, sessions.map((argv) => argv.slice(0, 8).join(" ")).join("\n"));
    assert.deepEqual(sessions[0].slice(0, 6), ["shell", "--client", "fake", "--lease", "lease-9m2qd", "--"]);
    assert.equal(sessions[0][7], "-c");
    // The CLI refuses to describe the drivers of a lease with members: it is not asked.
    assert.deepEqual(callsMatching("describe", "lease"), []);

    const power = await child(phone, "power");
    assert.deepEqual(
      (await rows(power)).map((row) => row.split(" | ")[0]),
      ["j phone power cycle", "j phone power off", "j phone power on", "j phone power read", "j phone power status"],
    );
  });

  test("a role's command runs as `j ROLE DRIVER ...` in the lease", async () => {
    const lease = await leaseNode("lease-9m2qd");
    const power = await child(await child(lease, "headunit"), "power");
    const on = await child(power, "j headunit power on");
    const terminal = await captureTerminal(() =>
      Promise.resolve(vscode.commands.executeCommand("jumpstarter.leases.runDeviceCommand", on)),
    );
    assert.equal(terminal.shellPath, undefined);
    assert.equal(terminal.name, "j headunit power on");
  });

  test("one shell for the lease, and extend and end act on the lease as one", async () => {
    const lease = await leaseNode("lease-9m2qd");
    const shell = await captureTerminal(() =>
      Promise.resolve(vscode.commands.executeCommand("jumpstarter.leases.openShell", lease)),
    );
    assert.match(terminalArgv(shell), /shell --client fake --lease lease-9m2qd$/);

    clearCliCalls();
    const restoreUi = stubUi({ quickPicks: ["2h"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.extend", lease);
    } finally {
      restoreUi();
    }
    assert.deepEqual(expectCall("update", "lease", "lease-9m2qd").slice(3, 5), ["--duration", "2h"]);

    // The confirmation names what goes back: the template and its roles, not an exporter that is not there.
    const window = vscode.window as unknown as Record<string, unknown>;
    const original = window.showWarningMessage;
    let asked = "";
    window.showWarningMessage = async (message: string) => {
      asked = message;
      return "End Lease";
    };
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.end", lease);
    } finally {
      window.showWarningMessage = original;
    }
    assert.equal(asked, "End lease 'lease-9m2qd' from template 'ivi' (roles phone, headunit)?");
    expectCall("delete", "leases", "lease-9m2qd");

    // A degraded lease is still held: it can be entered and ended like any lease in use.
    const degraded = await leaseNode("lease-degraded");
    const again = await captureTerminal(() =>
      Promise.resolve(vscode.commands.executeCommand("jumpstarter.leases.openShell", degraded)),
    );
    assert.match(terminalArgv(again), /--lease lease-degraded$/);
  });

  test("the lease opens in Jumpstarter Web as one view with all its roles", async () => {
    api.webUi.stopAll();
    clearCliCalls();
    const lease = await leaseNode("lease-9m2qd");
    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", lease);

    assert.deepEqual(errors, []);
    assert.deepEqual(opened, []);
    const links = api.webUi.panelLinks();
    assert.equal(links.length, 1);
    // The lease's view, with the window that shows the roles beside the first: not one driver of one role.
    assert.match(links[0], /^http:\/\/127\.0\.0\.1:\d+\/#\/d\/\?only=power,shell%2Fcompanions&chrome=none$/);
    // One server, inside the one session of the lease, serving every role.
    const [argv] = callsMatching("shell");
    assert.deepEqual(argv.slice(0, 6), ["shell", "--client", "fake", "--lease", "lease-9m2qd", "--"]);
    assert.ok(!argv.includes("-c"), "the lease's own view is not served as one role");
    assert.equal(argv[7], "serve");
    assert.equal(api.webUi.serverUrl("lease-9m2qd"), links[0].split("#")[0]);
    assert.deepEqual(callsMatching("describe", "lease"), []);

    // The whole workbench, in the browser, from the same server.
    clearCliCalls();
    await vscode.commands.executeCommand("jumpstarter.leases.openFullWebUi", lease);
    assert.deepEqual(callsMatching("shell"), []);
    assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/#\/d\/$/);
  });

  test("a role's driver view, and a role's screen, are served as that role alone", async () => {
    api.webUi.stopAll();
    const lease = await leaseNode("lease-9m2qd");
    const phone = await child(lease, "phone");
    const power = await child(phone, "power");
    assert.equal((await item(power)).contextValue, "jumpstarterDriver-web");

    clearCliCalls();
    await vscode.commands.executeCommand("jumpstarter.leases.openDriverView", power);
    assert.deepEqual(errors, []);
    let links = api.webUi.panelLinks();
    assert.equal(links.length, 1);
    // In the role's own server the driver's path is the driver's, as in a lease of one exporter.
    assert.match(links[0], /^http:\/\/127\.0\.0\.1:\d+\/#\/d\/power\?view=power%2Fmeter%23power&only=power&chrome=none$/);
    const [argv] = callsMatching("shell");
    assert.deepEqual(argv.slice(0, 6), ["shell", "--client", "fake", "--lease", "lease-9m2qd", "--"]);
    // (the session's interpreter runs the server as the role)
    assert.equal(argv[7], "-c");
    assert.match(argv[8], /JUMPSTARTER_HOST/);
    assert.equal(argv[9], "phone");
    assert.ok(argv.indexOf("serve") > 9);
    assert.equal(api.webUi.serverUrl("lease-9m2qd", "phone"), links[0].split("#")[0]);
    assert.equal(api.webUi.serverUrl("lease-9m2qd"), undefined);
    assert.equal(api.webUi.serverUrl("lease-9m2qd", "headunit"), undefined);

    // "Open Screen" on the role: the same server, the role's views together.
    clearCliCalls();
    await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", phone);
    assert.deepEqual(callsMatching("shell"), []);
    links = api.webUi.panelLinks();
    assert.equal(links.length, 2);
    assert.match(links[1], /#\/d\/\?only=power&chrome=none$/);
    assert.equal(new URL(links[1]).origin, new URL(links[0]).origin);

    // A role without an exporter has nothing to show, and nothing is started for it.
    const lost = await child(await leaseNode("lease-degraded"), "phone");
    const restoreUi = stubUi({});
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.openWebUi", lost);
    } finally {
      restoreUi();
    }
    assert.deepEqual(callsMatching("shell"), []);
  });

  test("with a jmp from before ports, forwards are shown without their direction and nothing fails", async () => {
    process.env.JMP_FAKE_NO_TEMPLATES = "1";
    try {
      // (a probe is what forgets the ports of the CLI before)
      await vscode.commands.executeCommand("jumpstarter.refresh");
      await api.refreshAll();
      const lease = await leaseNode("lease-9m2qd");
      await waitFor("the forward without its arrow", async () =>
        (await rows(lease)).includes("bt | headunit.rootcanal, phone.controller · Connected"),
      );
      assert.deepEqual(errors, []);
      // Asked once, refused, and not asked again at every refresh.
      clearCliCalls();
      await vscode.commands.executeCommand("jumpstarter.leases.refresh");
      assert.deepEqual(callsMatching("get", "exporters").filter((argv) => argv.includes("ports")), []);
    } finally {
      delete process.env.JMP_FAKE_NO_TEMPLATES;
      await vscode.commands.executeCommand("jumpstarter.refresh");
      await api.refreshAll();
    }
  });
});
