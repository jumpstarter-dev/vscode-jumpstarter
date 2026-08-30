/**
 * Unit tests for the in-flight lease store (src/services/pendingLeases).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 *
 * The store itself imports "vscode" for its event emitter, so only the pure
 * helper is exercised here; the store is covered by the integration tests.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { describePending } from "../../services/pendingLeasesModel";

const entry = { id: "pending-1", client: "belt", label: "board=qemu", startedAt: 1_000 };

test("describePending counts how long the request has been outstanding", () => {
  assert.equal(describePending(entry, 1_000), "acquiring…");
  assert.equal(describePending(entry, 13_400), "acquiring… 12s");
  // A clock that jumps backwards must not produce a negative age.
  assert.equal(describePending(entry, 0), "acquiring…");
});
