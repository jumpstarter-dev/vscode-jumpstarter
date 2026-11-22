import { defineConfig } from "@vscode/test-cli";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The same host as the integration tests, but against a real `jmp`, a real
// `jumpstarter-web` and a lease you hold: nothing is faked. Run it with
//
//   JMP_REAL_JMP=/path/to/venv/bin/jmp pnpm run test:real
//
// with JMP_CLIENT_CONFIG_HOME (and whatever else your client needs) in the
// environment, and an In-Use lease on the current client.
if (!process.env.JMP_REAL_JMP) {
  throw new Error("set JMP_REAL_JMP to the jmp executable of an environment that also has jumpstarter-web");
}

const ROOT = join(tmpdir(), "jumpstarter-real");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

export default defineConfig({
  files: "out/test/real/**/*.test.js",
  workspaceFolder: "./src/test/fixtures/workspace",
  launchArgs: [
    "--disable-extensions",
    "--user-data-dir",
    join(ROOT, "user-data"),
    // JMP_REAL_DEBUG_PORT: let a script outside take pictures of the window (Chrome DevTools Protocol).
    // (and keep the window painting while it is behind others: a page that is never painted never lays out)
    ...(process.env.JMP_REAL_DEBUG_PORT
      ? [
          `--remote-debugging-port=${process.env.JMP_REAL_DEBUG_PORT}`,
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
        ]
      : []),
  ],
  mocha: { ui: "tdd", timeout: 180_000 },
});
