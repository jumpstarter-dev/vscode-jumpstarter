/**
 * Unit tests for the writability check behind the config edit buttons.
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isWritable, sudoEditCommand } from "../../features/openConfig/access";

test("isWritable: true for a normal file, false for a read-only one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jumpstarter-openconfig-"));
  const writable = join(dir, "writable.yaml");
  const readOnly = join(dir, "readonly.yaml");
  writeFileSync(writable, "apiVersion: jumpstarter.dev/v1alpha1\n");
  writeFileSync(readOnly, "apiVersion: jumpstarter.dev/v1alpha1\n");
  chmodSync(readOnly, 0o444);

  assert.equal(await isWritable(writable), true);
  // Root ignores the permission bits, so this only holds for a normal user.
  if (process.getuid?.() !== 0) {
    assert.equal(await isWritable(readOnly), false);
  }
});

test("isWritable: false for a missing file", async () => {
  assert.equal(await isWritable(join(tmpdir(), "jumpstarter-does-not-exist.yaml")), false);
});

test("sudoEditCommand: edits the file in place with privileges", () => {
  assert.equal(
    sudoEditCommand("/etc/jumpstarter/exporters/lab.yaml"),
    "sudoedit /etc/jumpstarter/exporters/lab.yaml",
  );
});
