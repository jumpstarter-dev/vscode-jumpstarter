/**
 * Unit tests for the Clients feature's pure logic (src/features/clients/logic.ts).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host, and the
 * module under test must never import "vscode".
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  authBadge,
  buildClientCreateArgs,
  buildClientPickEntries,
  buildClientRows,
  buildLoginArgs,
  buildReauthArgs,
  needsReauth,
  parseLoginTarget,
  redactSecretArgs,
  rowContextValue,
  rowDescription,
  rowTooltipLines,
  validateAlias,
  validateLoginTarget,
  validateRequired,
  ClientRow,
} from "../../features/clients/logic";
import { AuthStatus, ClientConfigList } from "../../types";

function makeList(overrides: Partial<ClientConfigList> = {}): ClientConfigList {
  return {
    currentConfig: "beta",
    items: [
      {
        alias: "beta",
        path: "/home/u/.config/jumpstarter/clients/beta.yaml",
        endpoint: "grpc.beta.example.com:443",
        metadata: { name: "beta-client", namespace: "lab-b" },
      },
      {
        alias: "Alpha",
        path: "/home/u/.config/jumpstarter/clients/Alpha.yaml",
        endpoint: "grpc.alpha.example.com:443",
        metadata: { name: "alpha-client", namespace: "lab-a" },
      },
    ],
    ...overrides,
  };
}

function makeAuth(status: AuthStatus["status"], extra: Partial<AuthStatus> = {}): AuthStatus {
  return { status, expiresAt: null, remainingSeconds: null, ...extra };
}

function makeRow(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    alias: "beta",
    isCurrent: false,
    endpoint: "grpc.beta.example.com:443",
    path: "/home/u/.config/jumpstarter/clients/beta.yaml",
    namespace: "lab-b",
    name: "beta-client",
    auth: makeAuth("valid"),
    authError: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildClientRows
// ---------------------------------------------------------------------------

test("buildClientRows: sorts case-insensitively and marks the current client", () => {
  const auth = new Map<string, AuthStatus>([["beta", makeAuth("valid")]]);
  const rows = buildClientRows(makeList(), auth);
  assert.deepEqual(
    rows.map((r) => r.alias),
    ["Alpha", "beta"],
  );
  assert.equal(rows[0].isCurrent, false);
  assert.equal(rows[1].isCurrent, true);
  assert.equal(rows[1].auth?.status, "valid");
  assert.equal(rows[0].auth, undefined);
  assert.equal(rows[0].namespace, "lab-a");
  assert.equal(rows[0].name, "alpha-client");
});

test("buildClientRows: null currentConfig marks nothing current", () => {
  const rows = buildClientRows(makeList({ currentConfig: null }));
  assert.ok(rows.every((r) => !r.isCurrent));
});

test("buildClientRows: carries per-alias auth errors", () => {
  const errors = new Map([["beta", "boom"]]);
  const rows = buildClientRows(makeList(), new Map(), errors);
  assert.equal(rows.find((r) => r.alias === "beta")?.authError, "boom");
  assert.equal(rows.find((r) => r.alias === "Alpha")?.authError, undefined);
});

test("buildClientRows: empty list yields no rows", () => {
  assert.deepEqual(buildClientRows({ currentConfig: null, items: [] }), []);
});

// ---------------------------------------------------------------------------
// authBadge / needsReauth
// ---------------------------------------------------------------------------

test("authBadge: severity mapping", () => {
  assert.equal(authBadge("valid").severity, "ok");
  assert.equal(authBadge("no-expiry").severity, "ok");
  assert.equal(authBadge("expiring-soon").severity, "warn");
  assert.equal(authBadge("expired").severity, "bad");
  assert.equal(authBadge("no-token").severity, "bad");
  assert.equal(authBadge("invalid-token").severity, "bad");
  assert.equal(authBadge(undefined).severity, "unknown");
});

test("authBadge: the icon says how the client authenticates", () => {
  // Only an interactive login leaves a refresh token or an auth_time behind.
  assert.equal(authBadge("valid", makeAuth("valid", { refreshTokenStored: true })).icon, "globe");
  assert.equal(
    authBadge("valid", makeAuth("valid", { authTime: "2026-01-01T00:00:00Z" })).icon,
    "globe",
  );
  // An API key the cluster issued is itself a JWT, so it has an issuer too —
  // keying off that would call every API-key client an OIDC one.
  assert.equal(
    authBadge("valid", makeAuth("valid", { issuer: "https://localhost:8085" })).icon,
    "key",
  );
  assert.equal(authBadge("valid", makeAuth("valid")).icon, "key");
  assert.equal(authBadge("expired", makeAuth("expired")).icon, "key");
  // Nothing to authenticate with, or nothing known: a plain identity.
  assert.equal(authBadge("no-token", makeAuth("no-token")).icon, "account");
  assert.equal(authBadge(undefined).icon, "account");
});

test("authBadge: the colour says whether it is working", () => {
  const auth = makeAuth("valid");
  assert.equal(authBadge("valid", auth).color, "charts.green");
  assert.equal(authBadge("expiring-soon", auth).color, "charts.yellow");
  assert.equal(authBadge("expired", auth).color, "charts.red");
  assert.equal(authBadge(undefined).color, undefined);
});

test("needsReauth: only expired/no-token/invalid-token", () => {
  assert.equal(needsReauth("expired"), true);
  assert.equal(needsReauth("no-token"), true);
  assert.equal(needsReauth("invalid-token"), true);
  assert.equal(needsReauth("valid"), false);
  assert.equal(needsReauth("expiring-soon"), false);
  assert.equal(needsReauth("no-expiry"), false);
  assert.equal(needsReauth(undefined), false);
});

// ---------------------------------------------------------------------------
// Row presentation
// ---------------------------------------------------------------------------

test("rowDescription: healthy current client shows current + endpoint only", () => {
  const desc = rowDescription(makeRow({ isCurrent: true }));
  assert.equal(desc, "current · grpc.beta.example.com:443");
});

test("rowDescription: bad auth is surfaced", () => {
  const desc = rowDescription(makeRow({ auth: makeAuth("expired") }));
  assert.equal(desc, "token expired · grpc.beta.example.com:443");
});

test("rowContextValue: encodes current and needs-auth flags", () => {
  assert.equal(rowContextValue(makeRow()), "jumpstarterClient");
  assert.equal(rowContextValue(makeRow({ isCurrent: true })), "jumpstarterClientCurrent");
  assert.equal(
    rowContextValue(makeRow({ auth: makeAuth("no-token") })),
    "jumpstarterClientNeedsAuth",
  );
  assert.equal(
    rowContextValue(makeRow({ isCurrent: true, auth: makeAuth("expired") })),
    "jumpstarterClientCurrentNeedsAuth",
  );
});

test("rowContextValue: matches the documented when-clause regexes", () => {
  const anyClient = /^jumpstarterClient/;
  const nonCurrent = /^jumpstarterClient(NeedsAuth)?$/;
  const needsAuth = /NeedsAuth/;
  const current = rowContextValue(makeRow({ isCurrent: true }));
  const plain = rowContextValue(makeRow());
  const expired = rowContextValue(makeRow({ auth: makeAuth("expired") }));
  assert.ok(anyClient.test(current) && anyClient.test(plain) && anyClient.test(expired));
  assert.ok(!nonCurrent.test(current));
  assert.ok(nonCurrent.test(plain) && nonCurrent.test(expired));
  assert.ok(needsAuth.test(expired) && !needsAuth.test(plain));
});

test("rowTooltipLines: includes identity, auth and path — never token material", () => {
  const lines = rowTooltipLines(
    makeRow({
      isCurrent: true,
      auth: makeAuth("expiring-soon", {
        expiresAt: "2026-08-29T12:00:00Z",
        subject: "user@example.com",
      }),
    }),
  );
  assert.equal(lines[0], "**beta** (current client)");
  assert.ok(lines.includes("Endpoint: grpc.beta.example.com:443"));
  assert.ok(lines.includes("Identity: lab-b/beta-client"));
  assert.ok(lines.includes("Auth: token expiring soon"));
  assert.ok(lines.includes("Expires: 2026-08-29T12:00:00Z"));
  assert.ok(lines.includes("Config: /home/u/.config/jumpstarter/clients/beta.yaml"));
});

test("rowTooltipLines: surfaces auth-check failures", () => {
  const lines = rowTooltipLines(makeRow({ auth: undefined, authError: "spawn failed" }));
  assert.ok(lines.includes("Auth: auth unknown"));
  assert.ok(lines.includes("Auth check failed: spawn failed"));
});

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

test("buildLoginArgs: passes the [name@]endpoint target through, trimmed", () => {
  assert.deepEqual(buildLoginArgs(" myclient@jump.example.com "), [
    "login",
    "myclient@jump.example.com",
  ]);
});

test("buildReauthArgs: login scoped to an existing client", () => {
  assert.deepEqual(buildReauthArgs("beta"), ["login", "--client", "beta"]);
});

test("buildClientCreateArgs: every flag present plus --nointeractive", () => {
  const args = buildClientCreateArgs({
    alias: "lab",
    namespace: "ns1",
    name: "cli1",
    endpoint: "grpc.example.com:443",
    token: "sekrit",
  });
  assert.deepEqual(args, [
    "config",
    "client",
    "create",
    "lab",
    "--namespace",
    "ns1",
    "--name",
    "cli1",
    "-e",
    "grpc.example.com:443",
    "-t",
    "sekrit",
    "-a",
    "",
    "--nointeractive",
  ]);
});

test("redactSecretArgs: masks token values in both flag styles", () => {
  const args = buildClientCreateArgs({
    alias: "lab",
    namespace: "ns1",
    name: "cli1",
    endpoint: "e",
    token: "sekrit",
  });
  const redacted = redactSecretArgs(args);
  assert.ok(!redacted.includes("sekrit"));
  assert.equal(redacted[redacted.indexOf("-t") + 1], "***");
  assert.deepEqual(redactSecretArgs(["--token=sekrit", "--password=hunter2", "-e", "host"]), [
    "--token=***",
    "--password=***",
    "-e",
    "host",
  ]);
  // Non-secret args are untouched.
  assert.deepEqual(redactSecretArgs(["config", "client", "list"]), ["config", "client", "list"]);
});

// ---------------------------------------------------------------------------
// Validation / parsing
// ---------------------------------------------------------------------------

test("validateAlias: accepts sane aliases, rejects the rest", () => {
  assert.equal(validateAlias("default"), undefined);
  assert.equal(validateAlias("lab-1.env_x"), undefined);
  assert.equal(validateAlias("a"), undefined);
  assert.notEqual(validateAlias(""), undefined);
  assert.notEqual(validateAlias("  "), undefined);
  assert.notEqual(validateAlias("has space"), undefined);
  assert.notEqual(validateAlias("-leading"), undefined);
  assert.notEqual(validateAlias("trailing-"), undefined);
  assert.notEqual(validateAlias("sl/ash"), undefined);
});

test("validateRequired: trims before checking", () => {
  const v = validateRequired("Namespace");
  assert.equal(v("ns"), undefined);
  assert.notEqual(v(""), undefined);
  assert.notEqual(v("   "), undefined);
});

test("validateLoginTarget: endpoint with optional single name@ prefix", () => {
  assert.equal(validateLoginTarget("jump.example.com"), undefined);
  assert.equal(validateLoginTarget("me@jump.example.com"), undefined);
  assert.notEqual(validateLoginTarget(""), undefined);
  assert.notEqual(validateLoginTarget("has space.com"), undefined);
  assert.notEqual(validateLoginTarget("@nohost"), undefined);
  assert.notEqual(validateLoginTarget("noname@"), undefined);
  assert.notEqual(validateLoginTarget("a@b@c"), undefined);
});

test("parseLoginTarget: splits name from endpoint", () => {
  assert.deepEqual(parseLoginTarget("me@jump.example.com"), {
    name: "me",
    endpoint: "jump.example.com",
  });
  assert.deepEqual(parseLoginTarget(" jump.example.com "), { endpoint: "jump.example.com" });
});

// ---------------------------------------------------------------------------
// Quick pick entries
// ---------------------------------------------------------------------------

test("buildClientPickEntries: badges in labels, state in description", () => {
  const entries = buildClientPickEntries([
    makeRow({ alias: "good", isCurrent: true, auth: makeAuth("valid") }),
    makeRow({ alias: "stale", auth: makeAuth("expired"), endpoint: "" }),
  ]);
  // The icon says how the client authenticates; its state is in the colour
  // (in the tree) and the description (here), so it does not change with it.
  assert.equal(entries[0].label, "$(key) good");
  assert.equal(entries[0].description, "current");
  assert.equal(entries[0].detail, "grpc.beta.example.com:443");
  assert.equal(entries[1].label, "$(key) stale");
  assert.equal(entries[1].description, "token expired");
  assert.equal(entries[1].detail, undefined);
});

