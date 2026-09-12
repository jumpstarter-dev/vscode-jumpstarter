import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { buildKubectlApplyArgs, runKubectlApply } from "../../services/kubectl";

const fake = path.resolve(__dirname, "../../../src/test/fixtures/fake-kubectl.mjs");

test("kubectl apply preserves file arguments and administrative targeting", () => {
  assert.deepEqual(buildKubectlApplyArgs(["/tmp/a file;echo nope.yaml", "/tmp/second.yaml"], {
    namespace: "lab", kubeconfig: "/tmp/kube config", context: "test-context",
  }), [
    "apply", "-f", "/tmp/a file;echo nope.yaml", "-f", "/tmp/second.yaml",
    "-n", "lab", "--kubeconfig", "/tmp/kube config", "--context", "test-context", "-o", "name",
  ]);
});

test("kubectl validation is a server-side dry run, never a client-only check", () => {
  assert.deepEqual(buildKubectlApplyArgs(["manifest.yaml"], {}, true), [
    "apply", "-f", "manifest.yaml", "--dry-run=server", "-o", "name",
  ]);
  assert.throws(() => buildKubectlApplyArgs([]), /at least one/);
});

test("kubectl runner returns resource names, not full objects", async () => {
  const result = await runKubectlApply(fake, buildKubectlApplyArgs(["manifest.yaml"]));
  assert.equal(result.stdout, "client.jumpstarter.dev/drafted");
  assert.equal(result.stderr, "");
});

test("missing kubectl explains how to configure it", async () => {
  await assert.rejects(
    () => runKubectlApply(`${fake}-missing`, buildKubectlApplyArgs(["manifest.yaml"])),
    /Install it.*jumpstarter.kubectlPath/,
  );
});

test("kubectl nonzero exit surfaces stderr instead of reporting success", async () => {
  await assert.rejects(() => runKubectlApply(fake, ["invalid"]), /unexpected kubectl arguments/);
});
