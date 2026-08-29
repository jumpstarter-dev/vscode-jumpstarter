/**
 * Unit tests for the pure CLI-protocol logic. Run with `npm run test:unit`
 * (node --test on compiled output) — no VS Code host required.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildAuthStatusArgs,
  buildCreateLeaseArgs,
  buildDeleteLeaseArgs,
  buildDescribeArgs,
  buildDescribeLeaseWithDevicesArgs,
  buildGetExportersArgs,
  buildGetLeasesArgs,
  buildShellArgs,
  buildUpdateLeaseArgs,
  classifyError,
  computeCapabilities,
  extractWarnings,
  JmpError,
  parseGitVersion,
  parseJsonOutput,
  resolveConfigHome,
  summarizeStderr,
} from "../../services/jmpProtocol";
import { leaseRemainingSeconds, Lease } from "../../types";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("classifyError: exit 2 is usage", () => {
  assert.equal(classifyError(2, "Usage: jmp get [OPTIONS]..."), "usage");
});

test("classifyError: ENOENT spawn error is no-jmp-in-env", () => {
  assert.equal(classifyError(null, "", { spawnErrorCode: "ENOENT" }), "no-jmp-in-env");
});

test("classifyError: missing module is no-jmp-in-env", () => {
  assert.equal(
    classifyError(1, "/usr/bin/python3: No module named jumpstarter_cli"),
    "no-jmp-in-env",
  );
});

test("classifyError: expired token is auth-expired", () => {
  assert.equal(classifyError(1, "Error: token is expired, please run jmp login"), "auth-expired");
  assert.equal(classifyError(1, "Error: UNAUTHENTICATED: invalid bearer token"), "auth-expired");
});

test("classifyError: gRPC unavailable is connection-failed", () => {
  assert.equal(
    classifyError(1, "Error: <StatusCode.UNAVAILABLE: (14, 'unavailable')> failed to connect"),
    "connection-failed",
  );
  assert.equal(classifyError(1, "Error: connection refused"), "connection-failed");
  assert.equal(classifyError(1, "Error: Deadline Exceeded"), "connection-failed");
});

test("classifyError: unrecognized exit-1 error is unknown", () => {
  assert.equal(
    classifyError(1, "Error: Failed to load config: Client config 'x.yaml' does not exist."),
    "unknown",
  );
});

test("summarizeStderr picks the error line", () => {
  const s = "Warning: something minor\nError: exporter not found\n";
  assert.equal(summarizeStderr(s), "Error: exporter not found");
  assert.equal(summarizeStderr(""), "jmp failed");
});

test("extractWarnings splits non-empty lines", () => {
  assert.deepEqual(extractWarnings("a\n\n b \r\n"), ["a", "b"]);
  assert.deepEqual(extractWarnings(""), []);
});

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

test("parseJsonOutput parses valid JSON", () => {
  const out = parseJsonOutput<{ gitVersion: string }>('{"gitVersion": "0.10.0"}\n', ["version"]);
  assert.equal(out.gitVersion, "0.10.0");
});

test("parseJsonOutput throws typed parse-error", () => {
  assert.throws(
    () => parseJsonOutput("not json", ["version"]),
    (err: unknown) => err instanceof JmpError && err.kind === "parse-error",
  );
});

// ---------------------------------------------------------------------------
// Arg construction
// ---------------------------------------------------------------------------

test("getExporters args include status columns and explicit client", () => {
  assert.deepEqual(buildGetExportersArgs("lab"), [
    "get",
    "exporters",
    "--with",
    "leases,online,status",
    "-o",
    "json",
    "--client",
    "lab",
  ]);
});

test("getLeases args honor includeEnded", () => {
  assert.deepEqual(buildGetLeasesArgs("lab"), ["get", "leases", "-o", "json", "--client", "lab"]);
  assert.ok(buildGetLeasesArgs("lab", true).includes("-a"));
});

test("createLease adds the created-by tag and -o name", () => {
  const args = buildCreateLeaseArgs("lab", {
    exporterName: "rpi4-01",
    duration: "30m",
    tags: { purpose: "ci" },
  });
  assert.deepEqual(args.slice(0, 4), ["create", "lease", "--client", "lab"]);
  assert.ok(args.includes("-n") && args.includes("rpi4-01"));
  assert.ok(args.includes("--duration") && args.includes("30m"));
  assert.ok(args.includes("purpose=ci"));
  assert.ok(args.includes("jumpstarter.dev/created-by=vscode"));
  assert.deepEqual(args.slice(-2), ["-o", "name"]);
});

test("createLease with selector uses -l", () => {
  const args = buildCreateLeaseArgs("lab", { selector: "board=rpi4", duration: "1h" });
  assert.ok(args.includes("-l") && args.includes("board=rpi4"));
  assert.ok(!args.includes("-n"));
});

test("createLease requires exactly one of exporterName/selector", () => {
  assert.throws(
    () => buildCreateLeaseArgs("lab", { duration: "30m" }),
    (e: unknown) => e instanceof JmpError && e.kind === "usage",
  );
  assert.throws(
    () => buildCreateLeaseArgs("lab", { duration: "30m", exporterName: "a", selector: "b=c" }),
    (e: unknown) => e instanceof JmpError && e.kind === "usage",
  );
});

test("delete/update lease args", () => {
  assert.deepEqual(buildDeleteLeaseArgs("lab", "L1"), [
    "delete",
    "leases",
    "L1",
    "--client",
    "lab",
  ]);
  assert.deepEqual(buildUpdateLeaseArgs("lab", "L1", "1h"), [
    "update",
    "lease",
    "L1",
    "--duration",
    "1h",
    "--client",
    "lab",
  ]);
});

test("auth status args", () => {
  assert.deepEqual(buildAuthStatusArgs("lab"), [
    "auth",
    "status",
    "--client",
    "lab",
    "-o",
    "json",
  ]);
});

test("describe args with and without client", () => {
  assert.deepEqual(buildDescribeArgs("exporter", "e1", "lab"), [
    "describe",
    "exporter",
    "e1",
    "-o",
    "json",
    "--client",
    "lab",
  ]);
  assert.deepEqual(buildDescribeArgs("client", "c1"), ["describe", "client", "c1", "-o", "json"]);
  assert.deepEqual(buildDescribeLeaseWithDevicesArgs("lab", "L1"), [
    "describe",
    "lease",
    "L1",
    "--devices",
    "-o",
    "json",
    "--client",
    "lab",
  ]);
});

test("shell args always pass --lease; command goes after --", () => {
  assert.deepEqual(buildShellArgs("lab", "L1"), ["shell", "--client", "lab", "--lease", "L1"]);
  assert.deepEqual(buildShellArgs("lab", "L1", ["j", "power", "on"]), [
    "shell",
    "--client",
    "lab",
    "--lease",
    "L1",
    "--",
    "j",
    "power",
    "on",
  ]);
});

// ---------------------------------------------------------------------------
// Version gate
// ---------------------------------------------------------------------------

test("parseGitVersion handles release and dev versions", () => {
  assert.deepEqual(parseGitVersion("0.7.1"), [0, 7, 1]);
  assert.deepEqual(parseGitVersion("0.10.0.dev34+gd787eecab.d20260829"), [0, 10, 0]);
  assert.deepEqual(parseGitVersion("v1.2"), [1, 2, 0]);
  assert.equal(parseGitVersion("garbage"), null);
});

test("computeCapabilities gates on version", () => {
  assert.equal(computeCapabilities("0.10.0.dev34+g").authStatus, true);
  assert.equal(computeCapabilities("1.0.0").driverList, true);
  assert.equal(computeCapabilities("0.6.0").authStatus, false);
});

// ---------------------------------------------------------------------------
// Config home
// ---------------------------------------------------------------------------

test("resolveConfigHome prefers JMP_CLIENT_CONFIG_HOME", () => {
  assert.equal(resolveConfigHome({ JMP_CLIENT_CONFIG_HOME: "/custom" }, "/home/u"), "/custom");
  assert.equal(resolveConfigHome({}, "/home/u"), "/home/u/.config/jumpstarter");
  assert.equal(resolveConfigHome({ JMP_CLIENT_CONFIG_HOME: "  " }, "/home/u"), "/home/u/.config/jumpstarter");
});

// ---------------------------------------------------------------------------
// Lease remaining time
// ---------------------------------------------------------------------------

function makeLease(overrides: Partial<Lease>): Lease {
  return {
    name: "L1",
    namespace: "default",
    selector: "",
    exporter: "e",
    exporter_name: "e",
    client: "lab",
    duration: 1800.0,
    effective_begin_time: null,
    effective_end_time: null,
    begin_time: null,
    tags: {},
    context: {},
    conditions: [],
    status: "In-Use",
    ...overrides,
  };
}

test("leaseRemainingSeconds computes begin + duration - now", () => {
  const now = new Date("2026-01-01T00:20:00Z");
  const lease = makeLease({ effective_begin_time: "2026-01-01T00:00:00Z", duration: 1800 });
  assert.equal(leaseRemainingSeconds(lease, now), 600);
});

test("leaseRemainingSeconds is null without a begin time", () => {
  assert.equal(leaseRemainingSeconds(makeLease({}), new Date()), null);
  assert.equal(
    leaseRemainingSeconds(makeLease({ effective_begin_time: "bogus" }), new Date()),
    null,
  );
});

test("leaseRemainingSeconds can be negative for over-run leases", () => {
  const now = new Date("2026-01-01T01:00:00Z");
  const lease = makeLease({ effective_begin_time: "2026-01-01T00:00:00Z", duration: 1800 });
  assert.equal(leaseRemainingSeconds(lease, now), -1800);
});
