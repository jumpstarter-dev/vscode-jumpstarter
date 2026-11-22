/**
 * The Web UI commands against a real lease: a real `jmp`, a real
 * `jumpstarter-web`, a real exporter. See .vscode-test.real.mjs.
 *
 * Nothing is replaced. The panels really open; the run then asks the server
 * each one frames what a browser inside a VS Code webview would ask it, so it
 * proves the page may be framed there and nowhere else.
 */

import * as assert from "assert";
import * as http from "http";
import * as vscode from "vscode";
import type { JumpstarterApi } from "../../extension";

const EXTENSION_ID = "jumpstarter.vscode-jumpstarter";

async function waitFor<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
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

/** A GET with exactly these headers (fetch adds and drops some of its own). */
function get(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      })
      .on("error", reject);
  });
}

suite("web UI, for real", () => {
  let api: JumpstarterApi;
  let leaseNode: unknown;
  const errors: string[] = [];
  let restore: () => void = () => {};

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration("jumpstarter");
    await config.update("jmpPath", process.env.JMP_REAL_JMP, vscode.ConfigurationTarget.Global);
    await config.update("experimentalCliFeatures", true, vscode.ConfigurationTarget.Global);
    await config.update("pollIntervalSeconds", 3600, vscode.ConfigurationTarget.Global);
    if (process.env.JMP_REAL_THEME) {
      await vscode.workspace
        .getConfiguration("workbench")
        .update("colorTheme", process.env.JMP_REAL_THEME, vscode.ConfigurationTarget.Global);
    }

    const extension = vscode.extensions.getExtension<JumpstarterApi>(EXTENSION_ID);
    assert.ok(extension, "the extension is not installed in the host");
    api = await extension.activate();
    await vscode.commands.executeCommand("jumpstarter.refresh");
    await api.webUi.refreshViews();

    leaseNode = await waitFor("an In-Use lease of the current client", async () => {
      await vscode.commands.executeCommand("jumpstarter.leases.refresh");
      for (const node of (await api.trees.leases.getChildren()) ?? []) {
        const item = await api.trees.leases.getTreeItem(node);
        if (String(item.description ?? "").includes("In-Use")) {
          return node;
        }
      }
      return undefined;
    });

    const window = vscode.window as unknown as Record<string, unknown>;
    const original = window.showErrorMessage;
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
    restore = () => {
      window.showErrorMessage = original;
    };
  });

  suiteTeardown(() => {
    api?.webUi.stopAll();
    restore();
  });

  test("the lease's drivers with a plugin view open it in a panel the server lets be framed", async () => {
    const offered: { label: string; node: unknown }[] = [];
    const all: string[] = [];
    for (const node of (await api.trees.leases.getChildren(leaseNode)) ?? []) {
      const item = await api.trees.leases.getTreeItem(node);
      all.push(`${String(item.label)} (${String(item.description)}) ${item.contextValue}`);
      if (item.contextValue === "jumpstarterDriver-web") {
        offered.push({ label: String(item.label), node });
      }
    }
    console.log(`drivers:\n  ${all.join("\n  ")}`);
    assert.ok(offered.length > 0, "no driver of this lease has a plugin view");

    for (const { label, node } of offered) {
      await vscode.commands.executeCommand("jumpstarter.leases.openDriverView", node);
      assert.deepEqual(errors, []);
      const links = api.webUi.panelLinks();
      console.log(`panel for ${label}: ${links[links.length - 1]}`);
    }
    assert.equal(api.webUi.panelLinks().length, offered.length);

    const base = api.webUi.panelLinks()[0].split("#")[0];
    // What the frame of a webview asks: a navigation from another site, for a frame.
    const framed = await get(base, {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
    });
    assert.equal(framed.status, 200);
    const policy = String(framed.headers["content-security-policy"] ?? "");
    console.log(`policy: ${/frame-ancestors[^;]*/.exec(policy)?.[0]}`);
    assert.match(policy, /frame-ancestors vscode-file: vscode-webview:/);
    assert.equal(framed.headers["x-frame-options"], undefined);
    const cookie = String(framed.headers["set-cookie"] ?? "");
    assert.match(cookie, /SameSite=None; Secure; Partitioned/);
    // ...and the page's own requests from inside it, with the session it was given.
    for (const route of ["api/v1/info", "api/v1/drivers", "api/v1/plugins", "api/v1/hosting"]) {
      const response = await get(new URL(route, base).toString(), {
        Cookie: cookie.split(";")[0],
        "Sec-Fetch-Site": "same-origin",
      });
      console.log(`GET ${route} -> ${response.status}`);
      assert.equal(response.status, 200, route);
    }
    // A page of another site, with the same cookie, is still refused.
    const other = await get(new URL("api/v1/info", base).toString(), {
      Cookie: cookie.split(";")[0],
      "Sec-Fetch-Site": "cross-site",
      Origin: "https://evil.example",
    });
    assert.equal(other.status, 403);
  });

  // For looking at it: JMP_REAL_SHOW=hmi,appium opens those drivers' views and keeps the window up for
  // JMP_REAL_HOLD seconds; JMP_REAL_THEME picks the colour theme the window has meanwhile.
  test("show driver views and hold the window", async function () {
    const show = (process.env.JMP_REAL_SHOW ?? "").split(",").filter((name) => name.length > 0);
    if (show.length === 0) {
      this.skip();
    }
    this.timeout(600_000);
    api.webUi.closePanels();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.view.extension.jumpstarter");
    for (const node of (await api.trees.leases.getChildren(leaseNode)) ?? []) {
      const item = await api.trees.leases.getTreeItem(node);
      if (show.includes(String(item.label))) {
        await vscode.commands.executeCommand("jumpstarter.leases.openDriverView", node);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    console.log("holding the window");
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.JMP_REAL_HOLD ?? "60") * 1000));
  });
});
