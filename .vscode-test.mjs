import { defineConfig } from "@vscode/test-cli";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One scratch root per run, handed to the host before it starts so the
// extension's config home is already redirected when it activates. Without
// this, a scaffold command would write into the developer's own
// ~/.config/jumpstarter.
const ROOT = join(tmpdir(), "jumpstarter-e2e");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "config"), { recursive: true });

export default defineConfig({
  // Only the integration suites: everything under out/test/unit is node:test,
  // which mocha cannot run — and does not need to (`pnpm run test:unit`).
  files: "out/test/integration/**/*.test.js",
  // A folder to open, so workspace settings and editors behave normally.
  workspaceFolder: "./src/test/fixtures/workspace",
  // Every other installed extension is off: these tests are about this one,
  // and a Python extension prompting for an interpreter would hang them. The
  // extension under development is loaded separately and stays enabled.
  launchArgs: ["--disable-extensions"],
  env: {
    JMP_CLIENT_CONFIG_HOME: join(ROOT, "config"),
    JMP_FAKE_LOG: join(ROOT, "calls.log"),
    JMP_FAKE_ROOT: ROOT,
  },
  mocha: {
    ui: "tdd",
    // Activation plus a few CLI round trips; generous so a slow machine does
    // not fail a test that is merely waiting.
    timeout: 60_000,
  },
});
