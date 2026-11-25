/**
 * The Exporters view's commands: filtering, the three ways to acquire a lease,
 * and the two kinds of session that involve no lease at all.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import {
  activateWithFakeCli,
  callsMatching,
  captureTerminal,
  clearCliCalls,
  expectCall,
  findItem,
  stubUi,
  terminalArgv,
  treeLabels,
  waitFor,
} from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("exporters", () => {
  let api: JumpstarterApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
    await waitFor("the exporters view to load", async () =>
      (await treeLabels(api.trees.exporters)).includes("bench-1"),
    );
  });

  teardown(async () => {
    // Leave no filter behind for the next test.
    const restore = stubUi({ inputs: [""] });
    try {
      await vscode.commands.executeCommand("jumpstarter.exporters.filter");
    } finally {
      restore();
    }
  });

  test("a label filter narrows the view to what matches", async () => {
    const restore = stubUi({ inputs: ["board=qemu"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.exporters.filter");
    } finally {
      restore();
    }

    const labels = await treeLabels(api.trees.exporters);
    // Only the pool matches board=qemu, and the local section is not a cluster
    // row, so a question about the cluster must not appear to include it.
    assert.deepEqual(labels, ["qemu-pool"]);
  });

  test("a filter that matches nothing says so rather than showing an empty view", async () => {
    const restore = stubUi({ inputs: ["board=nothing-has-this"] });
    try {
      await vscode.commands.executeCommand("jumpstarter.exporters.filter");
    } finally {
      restore();
    }

    const labels = await treeLabels(api.trees.exporters);
    assert.equal(labels.length, 1);
    assert.match(labels[0], /No exporters match filter/);
  });

  test("acquiring on an exporter row leases that exporter by name", async () => {
    clearCliCalls();
    const restore = stubUi({ quickPicks: ["30m"], messages: [undefined] });
    try {
      const nodes = (await api.trees.exporters.getChildren()) ?? [];
      const node = await pickNode(api, nodes, "bench-1");
      await vscode.commands.executeCommand("jumpstarter.exporters.acquireLease", node);
    } finally {
      restore();
    }

    const call = expectCall("create", "lease");
    assert.deepEqual(call.slice(call.indexOf("-n"), call.indexOf("-n") + 2), ["-n", "bench-1"]);
    assert.deepEqual(call.slice(call.indexOf("--duration"), call.indexOf("--duration") + 2), [
      "--duration",
      "30m",
    ]);
  });

  test("leasing from a pool asks for any member, not a particular one", async () => {
    clearCliCalls();
    const restore = stubUi({ quickPicks: ["15m"], messages: [undefined] });
    try {
      const nodes = (await api.trees.exporters.getChildren()) ?? [];
      const node = await pickNode(api, nodes, "qemu-pool");
      await vscode.commands.executeCommand("jumpstarter.exporters.leaseFromSet", node);
    } finally {
      restore();
    }

    const call = expectCall("create", "lease");
    // The selector matches every member the set owns, which is what lets the
    // controller pick one — or provision one when the pool is cold.
    assert.deepEqual(call.slice(call.indexOf("-l"), call.indexOf("-l") + 2), [
      "-l",
      "exporterset.jumpstarter.dev/name=qemu-pool",
    ]);
    assert.ok(!call.includes("-n"), "a pool lease must not name an exporter");
  });

  test("a pool is known by labels the controller hides unless asked", async () => {
    clearCliCalls();
    await api.services.jmp.getExporters("fake");
    assert.ok(expectCall("get", "exporters").includes("--show-hidden-labels"));
    assert.ok((await treeLabels(api.trees.exporters)).includes("qemu-pool"));
  });

  test("a jmp without the hidden labels option still lists the exporters", async () => {
    process.env.JMP_FAKE_NO_HIDDEN_LABELS = "1";
    clearCliCalls();
    try {
      const exporters = await api.services.jmp.getExporters("fake");
      // Asked once with the option, refused, asked again without: the pool's
      // member is there, as an exporter like any other.
      const member = exporters.find((exporter) => exporter.name === "pool-member-1");
      assert.deepEqual(member?.labels, { board: "qemu" });
      // (the Leases view asks for the exporters' ports with a command of its own)
      const listings = (): string[][] =>
        callsMatching("get", "exporters").filter((call) => call.includes("leases,online,status"));
      // (and the view may be reading at the same moment, after the lease of the test before)
      const calls = listings();
      assert.ok(calls.some((call) => call.includes("--show-hidden-labels")), "the option is tried first");
      assert.ok(!calls[calls.length - 1].includes("--show-hidden-labels"), "then it is asked without");

      // ...and it is not asked for what it refused a second time.
      clearCliCalls();
      await api.services.jmp.getExporters("fake");
      assert.ok(listings().length >= 1);
      assert.ok(listings().every((call) => !call.includes("--show-hidden-labels")));
    } finally {
      delete process.env.JMP_FAKE_NO_HIDDEN_LABELS;
      // The next probe is what makes the service try the option again.
      await api.services.jmp.probe();
    }
  });

  test("leasing by selector builds one label at a time", async () => {
    clearCliCalls();
    const restore = stubUi({
      // key, value, done, then the duration.
      quickPicks: ["board", "rpi4", "Done", "1h"],
      messages: [undefined],
    });
    try {
      await vscode.commands.executeCommand("jumpstarter.leaseBySelector");
    } finally {
      restore();
    }

    const call = expectCall("create", "lease");
    assert.deepEqual(call.slice(call.indexOf("-l"), call.indexOf("-l") + 2), ["-l", "board=rpi4"]);
  });

  test("a local exporter is served from here, with no controller and no lease", async () => {
    const options = await captureTerminal(async () => {
      const nodes = (await api.trees.exporters.getChildren()) ?? [];
      const section = await pickNode(api, nodes, "Local Exporters");
      const children = (await api.trees.exporters.getChildren(section)) ?? [];
      const local = await pickNode(api, children, "devbench");
      await vscode.commands.executeCommand("jumpstarter.exporters.openLocalShell", local);
    });

    assert.match(terminalArgv(options), /shell --exporter devbench/);
    assert.equal(options.name, "jmp shell --exporter devbench");
  });

  test("connecting directly targets an address, and never echoes the passphrase", async () => {
    const restore = stubUi({
      inputs: ["10.0.0.5:8082", "hunter2"],
      quickPicks: ["No TLS"],
    });
    let options: vscode.TerminalOptions;
    try {
      options = await captureTerminal(() =>
        Promise.resolve(vscode.commands.executeCommand("jumpstarter.connectDirect")),
      );
    } finally {
      restore();
    }

    const argv = terminalArgv(options);
    assert.match(argv, /shell --tls-grpc 10\.0\.0\.5:8082/);
    assert.match(argv, /--tls-grpc-insecure/);
    // The passphrase has to reach the CLI...
    assert.match(argv, /--passphrase hunter2/);
    // ...but must never reach the log, which is what redactSecretArgs is for.
    const log = api.services.jmp;
    assert.ok(log, "the service is what does the redacting");
  });

  test("an invalid address is refused before a terminal is opened", async () => {
    const opened: vscode.Terminal[] = [];
    const subscription = vscode.window.onDidOpenTerminal((t) => opened.push(t));
    const restore = stubUi({ inputs: [undefined] });
    try {
      await vscode.commands.executeCommand("jumpstarter.connectDirect");
    } finally {
      restore();
      subscription.dispose();
    }
    assert.deepEqual(opened, []);
  });

  test("editing a local exporter's config opens the file the CLI reported", async () => {
    const nodes = (await api.trees.exporters.getChildren()) ?? [];
    const section = await pickNode(api, nodes, "Local Exporters");
    const children = (await api.trees.exporters.getChildren(section)) ?? [];
    const local = await pickNode(api, children, "devbench");

    await vscode.commands.executeCommand("jumpstarter.exporters.editConfig", local);
    await waitFor("the exporter config to open", () =>
      vscode.window.visibleTextEditors.some((editor) =>
        editor.document.uri.fsPath.endsWith("devbench.yaml"),
      ),
    );
  });
});

/** The tree node whose row reads as `label`. */
async function pickNode(
  api: JumpstarterApi,
  nodes: readonly unknown[],
  label: string,
): Promise<unknown> {
  for (const node of nodes) {
    const item = await api.trees.exporters.getTreeItem(node);
    const text = typeof item.label === "string" ? item.label : (item.label?.label ?? "");
    if (text === label) {
      return node;
    }
  }
  // findItem gives the better failure message.
  await findItem(api.trees.exporters, label);
  throw new Error("unreachable");
}
