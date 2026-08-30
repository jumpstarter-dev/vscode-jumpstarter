import { defineConfig } from "@vscode/test-cli";

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
  mocha: {
    ui: "tdd",
    // Activation plus a few CLI round trips; generous so a slow machine does
    // not fail a test that is merely waiting.
    timeout: 60_000,
  },
});
