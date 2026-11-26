/**
 * Acquiring a lease: the argv it sends, and the row it shows while waiting.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { activateWithFakeCli, clearCliCalls, expectCall, iconIdOf, stubUi, treeLabels, waitFor } from "./harness";
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
    // (the fake CLI has the lease as ended from here on: the next test starts with the leases it is given)
    clearCliCalls();
  });

  test("a lease that is being ended is its own row, releasing, until it is gone", async function () {
    this.timeout(30_000);
    clearCliCalls();
    await api.refreshAll();
    // The controller takes the request at once and gives the exporter back three seconds later.
    process.env.JMP_FAKE_RELEASE_TAKES = "3000";
    const restore = stubUi({ messages: ["End Lease"] });
    const leaseRows = async (): Promise<{ row: string; context: string; icon: string | undefined }[]> => {
      const rows = [];
      for (const node of (await api.trees.leases.getChildren()) ?? []) {
        const item = await api.trees.leases.getTreeItem(node);
        const label = typeof item.label === "string" ? item.label : (item.label?.label ?? "");
        rows.push({
          row: `${label} | ${String(item.description ?? "")}`,
          context: String(item.contextValue ?? ""),
          icon: iconIdOf(item),
        });
      }
      return rows;
    };
    const seen: Awaited<ReturnType<typeof leaseRows>>[] = [];
    let place = -1;
    try {
      const node = ((await api.trees.leases.getChildren()) ?? []).find(
        (candidate) => (candidate as { lease?: { name?: string } }).lease?.name === "lease-1",
      );
      assert.ok(node, "the lease is listed before it is ended");
      place = (await leaseRows()).findIndex((entry) => /^lease-1 \|/.test(entry.row));
      let done = false;
      const ending = Promise.resolve(vscode.commands.executeCommand("jumpstarter.leases.end", node)).finally(() => {
        done = true;
      });
      while (!done) {
        seen.push(await leaseRows());
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await ending;
      // Once it is released the row is gone: it does not come back as it was for a moment.
      const after = await leaseRows();
      assert.ok(!after.some((entry) => /^lease-1 \|/.test(entry.row)), JSON.stringify(after));
    } finally {
      restore();
      delete process.env.JMP_FAKE_RELEASE_TAKES;
    }
    expectCall("delete", "leases", "lease-1");
    // From the confirmation until the lease is gone: its row, saying it is going, with a spinner and no action.
    const first = seen.findIndex((rows) => rows.some((entry) => /releasing…/.test(entry.row)));
    assert.ok(first >= 0, "the row says the lease is being released");
    const during = seen.slice(first);
    assert.ok(during.length >= 10, `shown while the controller releases it (${during.length} readings)`);
    for (const rows of during) {
      const mine = rows.filter((entry) => /^lease-1 \|/.test(entry.row));
      assert.equal(mine.length, 1, `one row for the lease at every reading: ${JSON.stringify(rows)}`);
      assert.match(mine[0].row, /^lease-1 \| bench-1 · releasing…/);
      assert.equal(mine[0].context, "jumpstarterLeaseReleasing");
      assert.equal(mine[0].icon, "loading~spin");
      // ... in the place it had before it was ended
      assert.equal(rows.indexOf(mine[0]), place, `the row keeps its place: ${JSON.stringify(rows)}`);
    }
    // (the fake CLI forgets what it ended: the suites after this one have the lease again)
    clearCliCalls();
    await api.refreshAll();
    await waitFor("the lease to be listed again", async () =>
      (await leaseRows()).some((entry) => /^lease-1 \|/.test(entry.row)),
    );
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
