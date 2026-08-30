/**
 * What the views do when the CLI does not cooperate.
 *
 * These matter more than the happy paths: a hardware lab is exactly where the
 * controller is unreachable and the token has expired, and the failure has to
 * land in the view as something the user can act on — never a silent empty
 * tree, and never an interactive login started behind their back.
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { activateWithFakeCli, callsMatching, clearCliCalls, treeLabels, waitFor } from "./harness";
import type { JumpstarterApi } from "../../extension";

suite("failures", () => {
  let api: JumpstarterApi;

  suiteSetup(async function () {
    this.timeout(60_000);
    api = await activateWithFakeCli();
    await api.refreshAll();
  });

  teardown(async () => {
    delete process.env.JMP_FAKE_FAIL;
    delete process.env.JMP_FAKE_AUTH;
    await api.refreshAll();
  });

  test("a failing listing renders as an error row, not an empty view", async () => {
    process.env.JMP_FAKE_FAIL = "get exporters";
    await api.refreshAll();

    await waitFor("the failure to reach the view", async () => {
      const labels = await treeLabels(api.trees.exporters);
      return labels.some((label) => /fake failure requested/i.test(label));
    });
  });

  test("the view recovers on the next refresh once the CLI works again", async () => {
    process.env.JMP_FAKE_FAIL = "get exporters";
    await api.refreshAll();
    await waitFor("the failure", async () =>
      (await treeLabels(api.trees.exporters)).some((l) => /fake failure/i.test(l)),
    );

    delete process.env.JMP_FAKE_FAIL;
    await api.refreshAll();
    await waitFor("the exporters to come back", async () =>
      (await treeLabels(api.trees.exporters)).includes("bench-1"),
    );
  });

  test("an expired token stops polling and offers to re-authenticate", async () => {
    process.env.JMP_FAKE_AUTH = "expired";
    await api.refreshAll();

    await waitFor("the re-authenticate row", async () => {
      const labels = await treeLabels(api.trees.exporters);
      return labels.some((label) => /re-authenticate/i.test(label));
    });

    // Nothing may be asked of the controller with a token known to be expired:
    // a background call would start an interactive browser login and hang.
    clearCliCalls();
    await api.refreshAll();
    assert.deepEqual(
      callsMatching("get", "exporters"),
      [],
      "an expired client must not be polled",
    );
  });

  test("a cluster it cannot administer hides the view instead of showing an error", async () => {
    process.env.JMP_FAKE_FAIL = "admin get";

    // This is the probe the `jumpstarter.adminAvailable` context key is set
    // from, and the whole view is gated on it: no kubeconfig, no view.
    const denied = await api.services.jmp.probeAdmin({ namespace: "lab" });
    assert.equal(denied.ok, false);
    assert.match(String(denied.reason), /fake failure/i);

    // The client-facing views read different commands and keep working.
    await api.refreshAll();
    assert.ok((await treeLabels(api.trees.exporters)).includes("bench-1"));

    delete process.env.JMP_FAKE_FAIL;
    const allowed = await api.services.jmp.probeAdmin({ namespace: "lab" });
    assert.equal(allowed.ok, true);
  });

  test("applying a manifest the server rejects reports it and does not throw", async () => {
    const target = vscode.Uri.file(`${require("os").tmpdir()}/jumpstarter-apply-fails.yaml`);
    await vscode.workspace.fs.writeFile(
      target,
      Buffer.from("apiVersion: jumpstarter.dev/v1alpha1\nkind: Client\nmetadata:\n  name: x\n"),
    );
    process.env.JMP_FAKE_FAIL = "admin apply";

    let reported = "";
    const window = vscode.window as unknown as Record<string, unknown>;
    const original = window.showErrorMessage;
    window.showErrorMessage = async (message: string) => {
      reported = message;
      return undefined;
    };
    try {
      await vscode.commands.executeCommand("jumpstarter.applyManifest", target);
    } finally {
      window.showErrorMessage = original;
    }

    assert.match(reported, /apply failed/i);
  });
});
