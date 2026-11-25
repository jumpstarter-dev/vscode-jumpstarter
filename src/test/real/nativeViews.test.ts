/**
 * Native views against a real lease: a real `jmp`, a real exporter, the
 * extension's own copy of Jumpstarter Web. See .vscode-test.real.mjs.
 *
 * Nothing is replaced. Each driver that has a view is opened in a tab; the
 * page in it says what it did (it drew, it shows a picture, what failed, what
 * its policy blocked), and the extension counts what went over the bridge.
 * JMP_REAL_HOLD (seconds) keeps the window open after, to look at it. JMP_REAL_LEASE names the lease to use,
 * where the client holds more than one; JMP_REAL_VIEWS the drivers to open (by label).
 */

import * as assert from "assert";
import * as vscode from "vscode";
import type { JumpstarterApi } from "../../extension";

const EXTENSION_ID = "jumpstarter.vscode-jumpstarter";

async function waitFor<T>(what: string, read: () => Promise<T | undefined> | T | undefined, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

suite("native views, for real", () => {
  let api: JumpstarterApi;
  let leaseNode: unknown;
  const errors: string[] = [];

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration("jumpstarter");
    await config.update("jmpPath", process.env.JMP_REAL_JMP, vscode.ConfigurationTarget.Global);
    await config.update("experimentalCliFeatures", true, vscode.ConfigurationTarget.Global);
    await config.update("pollIntervalSeconds", 3600, vscode.ConfigurationTarget.Global);
    await config.update("webUi.transport", "bridge", vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension<JumpstarterApi>(EXTENSION_ID);
    assert.ok(extension, "the extension is not installed in the host");
    api = await extension.activate();
    assert.ok(api.views.bundle, "the extension carries no Jumpstarter Web: run scripts/sync-jumpstarter-web.sh");
    await vscode.commands.executeCommand("jumpstarter.refresh");
    await api.webUi.refreshViews();
    leaseNode = await waitFor("an In-Use lease of the current client", async () => {
      await vscode.commands.executeCommand("jumpstarter.leases.refresh");
      for (const node of (await api.trees.leases.getChildren()) ?? []) {
        const item = await api.trees.leases.getTreeItem(node);
        // JMP_REAL_LEASE names the lease to use: the client may hold others, which are someone's work
        const name = (node as { lease?: { name?: string } }).lease?.name;
        const wanted = process.env.JMP_REAL_LEASE;
        if (String(item.description ?? "").includes("In-Use") && (!wanted || name === wanted)) {
          return node;
        }
      }
      return undefined;
    });
    const window = vscode.window as unknown as Record<string, unknown>;
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
  });

  suiteTeardown(() => {
    api?.views.stopBridges();
  });

  test("every driver with a view opens in a tab that draws, with its data over the bridge", async () => {
    // (the lease's drivers are read from the lease itself, which takes a moment: its hooks run first)
    const offered = await waitFor("the lease's drivers that have a view", async () => {
      const found: { label: string; node: unknown }[] = [];
      const all: string[] = [];
      for (const node of (await api.trees.leases.getChildren(leaseNode)) ?? []) {
        const item = await api.trees.leases.getTreeItem(node);
        all.push(`${String(item.label)} ${item.contextValue}`);
        if (item.contextValue === "jumpstarterDriver-web") {
          found.push({ label: String(item.label), node });
        }
      }
      console.log(`drivers: ${all.join(", ")}`);
      return found.length > 0 ? found : undefined;
    });
    const wanted = process.env.JMP_REAL_VIEWS?.split(",");
    for (const { label, node } of offered.filter(({ label }) => !wanted || wanted.includes(label))) {
      const before = new Set(api.views.keys());
      await vscode.commands.executeCommand("jumpstarter.leases.openDriverView", node);
      assert.deepEqual(errors, []);
      const key = api.views.keys().find((candidate) => !before.has(candidate));
      assert.ok(key, `no tab opened for ${label}`);
      const seen = await waitFor(`${label} to draw`, () => {
        const now = api.views.diagnostics(key);
        return now?.notes.some((note) => note.kind === "rendered") ? now : undefined;
      });
      // a moment for the view itself: its plugin is imported and asks the device what it has
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.JMP_REAL_SETTLE ?? 8) * 1000));
      for (const note of seen.notes.filter((entry) => entry.kind === "trace")) {
        console.log(`  trace ${note.text}`);
      }
      console.log(`${key}\n  notes: ${JSON.stringify(seen.notes.filter((entry) => entry.kind !== "trace"))}\n  sent: ${JSON.stringify(seen.sent)}\n  received: ${JSON.stringify(seen.received)}\n  bytes of pictures: ${seen.bytesReceived}`);
      assert.deepEqual(
        seen.notes.filter((note) => note.kind === "error" || note.kind === "blocked"),
        [],
        `${label}: the page reported a failure`,
      );
      // the tab looks like the window: what is behind the view is the editor's own background
      const theme = seen.notes.find((note) => note.kind === "theme");
      assert.ok(theme, `${label}: the page did not say what it looks like`);
      const colors = JSON.parse(theme.text) as { editor: string; surfaces: string[]; host: string | null };
      assert.equal(colors.host, "true", "the page did not take the window's theme");
      for (const surface of colors.surfaces.filter((entry) => !/jws-hmi(\s|$)|jws-hmi-stage/.test(entry))) {
        assert.ok(surface.endsWith(colors.editor), `${label}: ${surface} is not the editor's background ${colors.editor}`);
      }
      assert.ok((seen.sent.request ?? 0) > 0, `${label}: the page asked the bridge nothing`);
      assert.ok((seen.received.response ?? 0) > 0, `${label}: the bridge answered nothing`);
    }
    const hold = Number(process.env.JMP_REAL_HOLD ?? 0);
    if (hold > 0) {
      await new Promise((resolve) => setTimeout(resolve, hold * 1000));
    }
  });
});
