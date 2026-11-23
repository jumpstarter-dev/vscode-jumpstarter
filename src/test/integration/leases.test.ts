/**
 * Acquiring a lease: the argv it sends, and the row it shows while waiting.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { activateWithFakeCli, clearCliCalls, expectCall, treeLabels, waitFor } from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("leases", () => {
  let api: JumpstarterApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
  });

  test("a request in flight is shown before the lease exists", async () => {
    const store = api.services.pendingLeases;
    const id = store.begin("fake", "board=rpi4");
    try {
      await waitFor("the pending row to appear", async () =>
        (await treeLabels(api.trees.leases)).includes("board=rpi4"),
      );
      // Both lease views show it: the same request, wherever you are looking.
      await waitFor("the pending row in the admin view", async () => {
        const nodes = (await api.trees.admin.getChildren()) ?? [];
        for (const node of nodes) {
          const item = await api.trees.admin.getTreeItem(node);
          if (item.label === "Leases") {
            const children = (await api.trees.admin.getChildren(node)) ?? [];
            const labels = await Promise.all(
              children.map(async (child) =>
                String((await api.trees.admin.getTreeItem(child)).label),
              ),
            );
            return labels.includes("board=rpi4");
          }
        }
        return false;
      });
    } finally {
      store.end(id);
    }

    await waitFor("the pending row to be withdrawn", async () =>
      !(await treeLabels(api.trees.leases)).includes("board=rpi4"),
    );
  });

  test("acquiring by exporter tags the lease and asks for a name back", async () => {
    clearCliCalls();
    await api.services.jmp.createLease("fake", { exporterName: "bench-1", duration: "15m" });

    const call = expectCall("create", "lease");
    assert.ok(call.includes("--client"), call.join(" "));
    assert.deepEqual(call.slice(call.indexOf("-n"), call.indexOf("-n") + 2), ["-n", "bench-1"]);
    assert.deepEqual(call.slice(call.indexOf("--duration"), call.indexOf("--duration") + 2), [
      "--duration",
      "15m",
    ]);
    // Leases made from the extension are marked so the views can badge them.
    assert.ok(
      call.some((arg) => arg === "created-by=vscode"),
      call.join(" "),
    );
    assert.deepEqual(call.slice(-2), ["-o", "name"]);
  });

  test("ending a lease releases it through the client that holds it", async () => {
    clearCliCalls();
    await api.services.jmp.deleteLease("fake", "lease-1");
    const call = expectCall("delete", "leases", "lease-1");
    assert.deepEqual(call.slice(3), ["--client", "fake"]);
  });

  test("a shell command is built without running it", async () => {
    const shell = await api.services.jmp.getShellCommand("fake", "lease-1");
    assert.ok(shell.args.includes("shell"));
    assert.deepEqual(shell.args.slice(-2), ["--lease", "lease-1"]);
  });

  test("stderr chatter never becomes data", async () => {
    // The fake writes an INFO line to stderr on every -o json call; if that
    // reached the parser, none of the views above would have rendered.
    const exporters = await api.services.jmp.getExporters("fake");
    assert.equal(exporters.length, 4);
    void vscode;
  });
});
