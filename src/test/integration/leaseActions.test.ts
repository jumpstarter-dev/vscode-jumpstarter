/**
 * What you can do with a lease you hold: open a session in it, run a file or a
 * driver command inside it, extend it, end it, and browse its driver tree.
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
  waitFor,
} from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("lease actions", () => {
  let api: JumpstarterApi;
  /** The tree node for the fake's in-use lease. */
  let leaseNode: unknown;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
    await waitFor("the lease to appear", async () => {
      leaseNode = await findLeaseNode(api);
      return leaseNode !== undefined;
    });
  });

  test("an in-use lease expands into the drivers in its session", async () => {
    const drivers = await labelsUnder(api, leaseNode);
    assert.deepEqual(drivers, ["power", "storage"]);
    expectCall("describe", "lease");
    // The driver tree costs a session, so it is asked for with --drivers.
    assert.ok(expectCall("describe", "lease").includes("--drivers"));
  });

  test("older integration CLIs are normalized to the driver-tree contract", async () => {
    process.env.JMP_FAKE_LEGACY_DRIVERS = "1";
    clearCliCalls();
    try {
      const result = await api.services.jmp.describeLeaseWithDrivers("fake", "lease-1");
      assert.ok(result.driver_tree.drivers.length > 0);
      assert.ok(!("devices" in result));
      const calls = callsMatching("describe", "lease");
      assert.equal(calls.length, 2);
      assert.ok(calls[0].includes("--drivers"));
      assert.ok(calls[1].includes("--devices"));
    } finally {
      delete process.env.JMP_FAKE_LEGACY_DRIVERS;
    }
  });

  test("driver introspection failures do not retry through the legacy API", async () => {
    process.env.JMP_FAKE_FAIL = "describe lease";
    clearCliCalls();
    try {
      await assert.rejects(() => api.services.jmp.describeLeaseWithDrivers("fake", "lease-1"));
      const calls = callsMatching("describe", "lease");
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes("--drivers"));
    } finally {
      delete process.env.JMP_FAKE_FAIL;
    }
  });

  test("a driver expands into the commands it can run", async () => {
    const children = (await api.trees.leases.getChildren(leaseNode)) ?? [];
    const power = await nodeLabelled(api, children, "power");
    assert.deepEqual(await labelsUnder(api, power), ["j power off", "j power on"]);
  });

  test("running a driver command sends it into the lease", async () => {
    const children = (await api.trees.leases.getChildren(leaseNode)) ?? [];
    const power = await nodeLabelled(api, children, "power");
    const commands = (await api.trees.leases.getChildren(power)) ?? [];
    const on = await nodeLabelled(api, commands, "j power on");

    const options = await captureTerminal(() =>
      Promise.resolve(vscode.commands.executeCommand("jumpstarter.leases.runDeviceCommand", on)),
    );
    // Sent to a shell rather than launched as the terminal's process, so the
    // output survives the command exiting.
    assert.equal(options.shellPath, undefined);
    assert.match(String(options.name), /power on/);
  });

  test("a command with a required argument prompts before running", async () => {
    const children = (await api.trees.leases.getChildren(leaseNode)) ?? [];
    const storage = await nodeLabelled(api, children, "storage");
    const commands = (await api.trees.leases.getChildren(storage)) ?? [];
    const flash = await nodeLabelled(api, commands, "j storage flash");

    let asked = false;
    const window = vscode.window as unknown as Record<string, unknown>;
    const original = window.showInputBox;
    window.showInputBox = async (options?: vscode.InputBoxOptions) => {
      asked = true;
      // The prompt carries Click's own help text for the parameter.
      assert.match(`${options?.prompt ?? ""} ${options?.title ?? ""}`, /Image to flash|source/);
      return "/tmp/image.img";
    };
    try {
      await captureTerminal(() =>
        Promise.resolve(
          vscode.commands.executeCommand("jumpstarter.leases.runDeviceCommand", flash),
        ),
      );
    } finally {
      window.showInputBox = original;
    }
    assert.ok(asked, "a required argument must be asked for, not sent empty");
  });

  test("opening a shell attaches to the lease rather than creating one", async () => {
    const options = await captureTerminal(() =>
      Promise.resolve(vscode.commands.executeCommand("jumpstarter.leases.openShell", leaseNode)),
    );
    const argv = terminalArgv(options);
    assert.match(argv, /shell --client fake --lease lease-1/);
    // Attaching, so there must be no create in sight.
    assert.ok(!argv.includes("create"));
  });

  test("running the current file runs it with the environment's interpreter", async () => {
    // A real file: the command hands a path to the CLI, so an untitled buffer
    // is refused (with a message) rather than run.
    const file = vscode.Uri.file(`${require("os").tmpdir()}/jumpstarter-run-me.py`);
    await vscode.workspace.fs.writeFile(file, Buffer.from("print('hello from the lease')\n"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));

    const options = await captureTerminal(() =>
      Promise.resolve(
        vscode.commands.executeCommand("jumpstarter.leases.runCurrentFile", leaseNode),
      ),
    );
    // Typed into a shell rather than launched as the terminal's process, so
    // the output stays on screen after the run finishes.
    assert.equal(options.shellPath, undefined);
    assert.match(String(options.name), /jumpstarter-run-me\.py/);
  });

  test("extending a lease sends the new duration", async () => {
    clearCliCalls();
    const restore = stubUi({ quickPicks: ["1h"], messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.extend", leaseNode);
    } finally {
      restore();
    }
    const call = expectCall("update", "lease", "lease-1");
    assert.deepEqual(call.slice(3, 5), ["--duration", "1h"]);
  });

  test("copying the export line gives something that can be pasted into a shell", async () => {
    // Do not read or overwrite the developer's desktop clipboard. Other apps
    // can also change it between the command and assertion on a real display.
    const original = Object.getOwnPropertyDescriptor(vscode.env, "clipboard")!;
    let copied = "";
    Object.defineProperty(vscode.env, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => { copied = text; },
        readText: async () => copied,
      },
    });
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.copyExport", leaseNode);
      assert.match(copied, /JMP_LEASE=lease-1/);
    } finally {
      Object.defineProperty(vscode.env, "clipboard", original);
    }
  });

  test("ending a lease asks first, and does nothing when refused", async () => {
    clearCliCalls();
    const restore = stubUi({ messages: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.end", leaseNode);
    } finally {
      restore();
    }
    assert.deepEqual(
      callsMatching("delete", "leases"),
      [],
      "declining the confirmation must not release the lease",
    );
  });

  test("ending a lease releases it once confirmed", async () => {
    clearCliCalls();
    const restore = stubUi({ messages: ["End Lease"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.leases.end", leaseNode);
    } finally {
      restore();
    }
    expectCall("delete", "leases", "lease-1");
  });

  test("showing ended leases asks the controller for them", async () => {
    clearCliCalls();
    await vscode.commands.executeCommand("jumpstarter.leases.toggleEnded");
    await waitFor("a listing that includes ended leases", () =>
      callsMatching("get", "leases").some((argv) => argv.includes("-a")),
    );
    // And back, so the next test sees the default view.
    await vscode.commands.executeCommand("jumpstarter.leases.toggleEnded");
  });
});

// ---------------------------------------------------------------------------

async function findLeaseNode(api: JumpstarterApi): Promise<unknown> {
  const nodes = (await api.trees.leases.getChildren()) ?? [];
  for (const node of nodes) {
    const item = await api.trees.leases.getTreeItem(node);
    if (String(item.description ?? "").includes("In-Use")) {
      return node;
    }
  }
  return undefined;
}

async function nodeLabelled(
  api: JumpstarterApi,
  nodes: readonly unknown[],
  label: string,
): Promise<unknown> {
  for (const node of nodes) {
    const item = await api.trees.leases.getTreeItem(node);
    const text = typeof item.label === "string" ? item.label : (item.label?.label ?? "");
    if (text === label) {
      return node;
    }
  }
  assert.fail(`no row labelled '${label}'`);
}

async function labelsUnder(api: JumpstarterApi, node: unknown): Promise<string[]> {
  const children = (await api.trees.leases.getChildren(node)) ?? [];
  const items = await Promise.all(children.map((child) => api.trees.leases.getTreeItem(child)));
  return items
    .map((item) => (typeof item.label === "string" ? item.label : (item.label?.label ?? "")))
    .sort();
}
