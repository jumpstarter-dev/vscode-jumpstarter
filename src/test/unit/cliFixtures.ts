/**
 * The output of the real CLI for leases with members, lease templates and
 * ports, as kept in src/test/fixtures/cli (its README says how each was made).
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

// out/test/unit/cliFixtures.js -> repo root
const ROOT = path.resolve(__dirname, "..", "..", "..", "src", "test", "fixtures", "cli");

export function fixtureText(name: string): string {
  return readFileSync(path.join(ROOT, name), "utf8");
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name));
}
