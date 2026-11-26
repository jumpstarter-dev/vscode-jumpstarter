/**
 * Unit tests for the pure Leases-view logic (src/features/leases/model.ts).
 * Run with `npm run test:unit` — plain node:test on compiled output, no
 * VS Code host and no vscode imports.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildCommandArgs,
  buildDriverNodes,
  buildExportLine,
  buildLeaseRow,
  collectCommands,
  CommandDescriptor,
  describeParam,
  findCliNode,
  formatRemaining,
  formatSpan,
  isActiveStatus,
  isValidDuration,
  isVscodeCreated,
  optionFlag,
  orderLeaseRows,
  promptableParams,
  releasingLeaseRow,
  shortLeaseName,
  sortLeases,
  tailOfPath,
  viewDescription,
} from "../../features/leases/model";
import { CliParam, CliTreeNode, Lease, LeaseDriverTree } from "../../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    name: "0198b2e3-1111-7aaa-8bbb-0242ac120002",
    namespace: "jumpstarter-lab",
    selector: "",
    exporter: "namespaces/jumpstarter-lab/exporters/dut-1",
    exporter_name: "dut-1",
    client: "kirk",
    duration: 1800.0,
    effective_begin_time: null,
    effective_end_time: null,
    begin_time: null,
    tags: {},
    context: {},
    conditions: [],
    status: "Waiting",
    ...overrides,
  };
}

function cliLeaf(name: string, help = ""): CliTreeNode {
  return { name, help, params: [], subcommands: {} };
}

function cliGroup(name: string, subcommands: Record<string, CliTreeNode>): CliTreeNode {
  return { name, help: "", params: [], subcommands };
}

// ---------------------------------------------------------------------------
// Name / time formatting
// ---------------------------------------------------------------------------

test("shortLeaseName: UUID names shorten to first segment", () => {
  assert.equal(shortLeaseName("0198b2e3-1111-7aaa-8bbb-0242ac120002"), "0198b2e3");
});

test("shortLeaseName: short non-UUID names pass through", () => {
  assert.equal(shortLeaseName("my-lease"), "my-lease");
});

test("shortLeaseName: long non-UUID names are ellipsized", () => {
  const long = "a".repeat(40);
  const short = shortLeaseName(long);
  assert.equal(short.length, 22);
  assert.ok(short.endsWith("…"));
});

test("formatSpan: hours, minutes, seconds", () => {
  assert.equal(formatSpan(5400), "1h 30m");
  assert.equal(formatSpan(725), "12m 5s");
  assert.equal(formatSpan(42), "42s");
  assert.equal(formatSpan(0), "0s");
});

test("formatRemaining: positive, negative and null", () => {
  assert.equal(formatRemaining(725), "12m 5s left");
  assert.equal(formatRemaining(-180), "overrun 3m 0s");
  assert.equal(formatRemaining(null), "");
});

// ---------------------------------------------------------------------------
// Lease rows
// ---------------------------------------------------------------------------

test("isVscodeCreated: only the created-by=vscode tag counts", () => {
  assert.equal(isVscodeCreated(makeLease()), false);
  assert.equal(isVscodeCreated(makeLease({ tags: { "created-by": "vscode" } })), true);
  // (the key of earlier versions)
  assert.equal(
    isVscodeCreated(makeLease({ tags: { "jumpstarter.dev/created-by": "vscode" } })),
    true,
  );
  assert.equal(
    isVscodeCreated(makeLease({ tags: { "jumpstarter.dev/created-by": "script" } })),
    false,
  );
});

test("isActiveStatus: In-Use and Waiting only", () => {
  assert.equal(isActiveStatus("In-Use"), true);
  assert.equal(isActiveStatus("Waiting"), true);
  assert.equal(isActiveStatus("Ended"), false);
  assert.equal(isActiveStatus("Expired"), false);
});

test("buildLeaseRow: In-Use lease shows exporter, status and live remaining time", () => {
  const begin = new Date("2026-08-29T10:00:00Z");
  const now = new Date("2026-08-29T10:10:00Z"); // 10 of 30 minutes used
  const lease = makeLease({
    status: "In-Use",
    effective_begin_time: begin.toISOString(),
  });
  const row = buildLeaseRow(lease, now);
  assert.equal(row.label, "0198b2e3");
  assert.equal(row.description, "dut-1 · In-Use · 20m 0s left");
  assert.equal(row.expandable, true);
  assert.equal(row.contextValue, "jumpstarterLease-inUse");
  assert.ok(row.tooltip.includes(lease.name));
});

test("buildLeaseRow: vscode-created lease gets the zap badge and -vscode context", () => {
  const row = buildLeaseRow(
    makeLease({
      status: "In-Use",
      effective_begin_time: new Date().toISOString(),
      tags: { "jumpstarter.dev/created-by": "vscode" },
    }),
  );
  assert.equal(row.icon, "zap");
  assert.equal(row.contextValue, "jumpstarterLease-inUse-vscode");
  assert.equal(row.createdByVscode, true);
  assert.ok(row.tooltip.includes("VS Code"));
});

test("buildLeaseRow: waiting lease has no remaining time and is not expandable", () => {
  const row = buildLeaseRow(makeLease({ status: "Waiting" }));
  assert.equal(row.description, "dut-1 · Waiting");
  assert.equal(row.expandable, false);
  assert.equal(row.contextValue, "jumpstarterLease-waiting");
});

test("buildLeaseRow: ended/expired leases map to the -ended context", () => {
  assert.equal(
    buildLeaseRow(makeLease({ status: "Ended" })).contextValue,
    "jumpstarterLease-ended",
  );
  assert.equal(
    buildLeaseRow(makeLease({ status: "Expired" })).contextValue,
    "jumpstarterLease-ended",
  );
});

test("sortLeases: active first, then stable by name", () => {
  const leases = [
    makeLease({ name: "b-ended", status: "Ended" }),
    makeLease({ name: "z-inuse", status: "In-Use" }),
    makeLease({ name: "a-wait", status: "Waiting" }),
    makeLease({ name: "a-inuse", status: "In-Use" }),
  ];
  assert.deepEqual(
    sortLeases(leases).map((l) => l.name),
    ["a-inuse", "z-inuse", "a-wait", "b-ended"],
  );
});

// ---------------------------------------------------------------------------
// Device / CLI tree
// ---------------------------------------------------------------------------

test("tailOfPath: dotted and slashed paths", () => {
  assert.equal(tailOfPath("dutlink.power"), "power");
  assert.equal(tailOfPath("a/b/c"), "c");
  assert.equal(tailOfPath("power"), "power");
});

test("findCliNode: walks subcommands and misses cleanly", () => {
  const root = cliGroup("j", {
    power: cliGroup("power", { on: cliLeaf("on"), off: cliLeaf("off") }),
  });
  assert.equal(findCliNode(root, ["power", "on"])?.name, "on");
  assert.equal(findCliNode(root, []), root);
  assert.equal(findCliNode(root, ["storage"]), undefined);
});

test("collectCommands: flattens leaves with full j-relative paths, sorted", () => {
  const power = cliGroup("power", {
    on: cliLeaf("on", "Turn power on"),
    off: cliLeaf("off"),
    cycle: cliLeaf("cycle"),
  });
  const commands = collectCommands(power, ["power"]);
  assert.deepEqual(
    commands.map((c) => c.label),
    ["j power cycle", "j power off", "j power on"],
  );
  assert.deepEqual(commands[2].cliPath, ["power", "on"]);
  assert.ok(commands[2].tooltip.includes("Turn power on"));
});

test("collectCommands: a leaf driver node yields itself as the single command", () => {
  const leaf = cliLeaf("reset", "Reset the board");
  assert.deepEqual(
    collectCommands(leaf, ["reset"]).map((c) => c.label),
    ["j reset"],
  );
});

test("collectCommands: required params surface in the tooltip", () => {
  const flash: CliTreeNode = {
    name: "flash",
    help: "Flash an image",
    params: [
      { name: "image", type: "str", help: "path", required: true, default: null },
      { name: "partition", type: "str", help: "", required: false, default: null },
    ],
    subcommands: {},
  };
  const [cmd] = collectCommands(flash, ["storage", "flash"]);
  assert.equal(cmd.label, "j storage flash");
  assert.ok(cmd.tooltip.includes("<image:str>"));
  assert.ok(cmd.tooltip.includes("[partition:str]"));
});

test("buildDriverNodes: matches drivers to cli subtrees by driver_path", () => {
  const driverTree: LeaseDriverTree = {
    drivers: [
      {
        path: "power",
        driver_path: ["power"],
        class: "jumpstarter_driver_power.driver.MockPower",
        description: "Mock power",
        methods: ["on", "off"],
      },
    ],
    cli_tree: cliGroup("j", {
      power: cliGroup("power", { on: cliLeaf("on"), off: cliLeaf("off") }),
    }),
  };
  const [node] = buildDriverNodes(driverTree);
  assert.equal(node.label, "power");
  assert.equal(node.description, "MockPower");
  assert.ok(node.tooltip.includes("on, off"));
  assert.deepEqual(
    node.commands.map((c) => c.label),
    ["j power off", "j power on"],
  );
});

test("buildDriverNodes: hides the root composite session handle", () => {
  const driverTree: LeaseDriverTree = {
    drivers: [
      {
        path: "client",
        driver_path: [],
        class: "jumpstarter_driver_composite.client.CompositeClient",
        description: "",
        methods: [],
      },
      {
        path: "client.power",
        driver_path: ["power"],
        class: "jumpstarter_driver_power.client.PowerClient",
        description: "",
        methods: ["on"],
      },
    ],
    cli_tree: cliGroup("j", { power: cliGroup("power", { on: cliLeaf("on") }) }),
  };
  const nodes = buildDriverNodes(driverTree);
  assert.deepEqual(
    nodes.map((n) => n.label),
    ["power"],
  );
});

test("buildDriverNodes: falls back to splitting the dotted path", () => {
  const driverTree: LeaseDriverTree = {
    drivers: [
      {
        path: "dutlink.power",
        driver_path: ["d1f0e9c8"], // opaque ids that do not match the cli tree
        class: "x.y.DutlinkPower",
        description: "",
        methods: [],
      },
    ],
    cli_tree: cliGroup("j", {
      dutlink: cliGroup("dutlink", { power: cliGroup("power", { on: cliLeaf("on") }) }),
    }),
  };
  const [node] = buildDriverNodes(driverTree);
  assert.deepEqual(
    node.commands.map((c) => c.label),
    ["j dutlink power on"],
  );
});

test("buildDriverNodes: driver without a matching cli subtree gets no commands", () => {
  const driverTree: LeaseDriverTree = {
    drivers: [
      {
        path: "mystery",
        driver_path: ["mystery"],
        class: "x.y.Mystery",
        description: "",
        methods: [],
      },
    ],
    cli_tree: cliGroup("j", {}),
  };
  const [node] = buildDriverNodes(driverTree);
  assert.deepEqual(node.commands, []);
  assert.equal(node.label, "mystery");
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

test("isValidDuration: accepts jmp-style durations", () => {
  for (const good of ["30m", "1h", "1h30m", "45s", "2d", "1d2h3m4s"]) {
    assert.equal(isValidDuration(good), true, good);
  }
  for (const bad of ["", "  ", "30", "m30", "abc", "1x", "30m1h"]) {
    assert.equal(isValidDuration(bad), false, bad);
  }
});

test("buildExportLine", () => {
  assert.equal(buildExportLine("abc-123"), "export JMP_LEASE=abc-123");
});

test("viewDescription", () => {
  assert.equal(viewDescription(null, false), "");
  assert.equal(viewDescription("kirk", false), "kirk");
  assert.equal(viewDescription("kirk", true), "kirk · incl. ended");
});

// ---------------------------------------------------------------------------
// Running a command with parameters
// ---------------------------------------------------------------------------

function makeParam(overrides: Partial<CliParam> = {}): CliParam {
  return {
    name: "port",
    kind: "argument",
    type: "integer",
    help: null,
    required: true,
    default: null,
    opts: ["port"],
    is_flag: false,
    multiple: false,
    nargs: 1,
    ...overrides,
  };
}

function makeCommand(params: CliParam[]): CommandDescriptor {
  return { cliPath: ["net", "forward-tcp"], label: "j net forward-tcp", tooltip: "", params };
}

test("promptableParams: splits required from optional", () => {
  const required = makeParam();
  const optional = makeParam({ name: "address", kind: "option", required: false });
  const split = promptableParams(makeCommand([optional, required]));
  assert.deepEqual(split.required.map((p) => p.name), ["port"]);
  assert.deepEqual(split.optional.map((p) => p.name), ["address"]);
});

test("optionFlag: prefers the long form", () => {
  assert.equal(optionFlag(makeParam({ opts: ["-a", "--address"] })), "--address");
  assert.equal(optionFlag(makeParam({ opts: [] })), "--port");
});

test("describeParam: names the flag, its type and default", () => {
  assert.equal(describeParam(makeParam()), "port (integer)");
  assert.equal(
    describeParam(
      makeParam({
        name: "address",
        kind: "option",
        type: "text",
        required: false,
        default: "0.0.0.0",
        opts: ["--address"],
      }),
    ),
    "--address [default: 0.0.0.0]",
  );
});

test("buildCommandArgs: positional arguments follow the cli path", () => {
  const args = buildCommandArgs(makeCommand([makeParam()]), new Map([["port", "8080"]]));
  assert.deepEqual(args, ["net", "forward-tcp", "8080"]);
});

test("buildCommandArgs: options are spelled by flag and precede arguments", () => {
  const command = makeCommand([
    makeParam({ name: "address", kind: "option", required: false, opts: ["--address"] }),
    makeParam(),
  ]);
  const args = buildCommandArgs(
    command,
    new Map([
      ["address", "127.0.0.1"],
      ["port", "8080"],
    ]),
  );
  // Options first, so a positional value that looks like a flag is not read as one.
  assert.deepEqual(args, ["net", "forward-tcp", "--address", "127.0.0.1", "8080"]);
});

test("buildCommandArgs: a boolean flag appears only when true", () => {
  const command = makeCommand([
    makeParam({
      name: "verbose",
      kind: "option",
      required: false,
      is_flag: true,
      opts: ["--verbose"],
    }),
  ]);
  assert.deepEqual(buildCommandArgs(command, new Map([["verbose", true]])), [
    "net",
    "forward-tcp",
    "--verbose",
  ]);
  assert.deepEqual(buildCommandArgs(command, new Map([["verbose", false]])), [
    "net",
    "forward-tcp",
  ]);
});

test("buildCommandArgs: a repeatable option contributes one flag per value", () => {
  const command = makeCommand([
    makeParam({ name: "tag", kind: "option", required: false, multiple: true, opts: ["--tag"] }),
  ]);
  assert.deepEqual(buildCommandArgs(command, new Map([["tag", ["a", "b"]]])), [
    "net",
    "forward-tcp",
    "--tag",
    "a",
    "--tag",
    "b",
  ]);
});

test("buildCommandArgs: skipped and empty values are left out", () => {
  const command = makeCommand([
    makeParam({ name: "address", kind: "option", required: false, opts: ["--address"] }),
    makeParam(),
  ]);
  const args = buildCommandArgs(
    command,
    new Map([
      ["address", ""],
      ["port", "8080"],
    ]),
  );
  assert.deepEqual(args, ["net", "forward-tcp", "8080"]);
});

test("buildCommandArgs: a command with no params is just its path", () => {
  assert.deepEqual(buildCommandArgs(makeCommand([]), new Map()), ["net", "forward-tcp"]);
});

test("a lease that was ended is a row that says it is going, with no action and nothing to open", () => {
  const lease = makeLease({ status: "In-Use", effective_begin_time: "2026-08-29T10:00:00Z" });
  const row = buildLeaseRow(lease, new Date("2026-08-29T10:10:00Z"));
  const going = releasingLeaseRow(row, "dut-1", "releasing… 3s");
  assert.equal(going.id, row.id); // the same row, not a second one
  assert.equal(going.label, row.label);
  assert.equal(going.description, "dut-1 · releasing… 3s");
  assert.equal(going.icon, "loading~spin");
  assert.equal(going.contextValue, "jumpstarterLeaseReleasing");
  assert.equal(going.expandable, false);
  assert.ok(going.tooltip.startsWith(row.tooltip));
  // a lease with nothing to call it by says only that it is going
  assert.equal(releasingLeaseRow(row, "", "releasing…").description, "releasing…");
});

test("a request for a lease is a row where its lease will be, so that it does not move when acquired", () => {
  const lease = (name: string, status: Lease["status"]): Lease => makeLease({ name, status });
  const leases = [lease("lease-b", "In-Use"), lease("lease-old", "Expired"), lease("lease-a", "In-Use"), lease("lease-w", "Waiting")];
  const names = (rows: ReturnType<typeof orderLeaseRows<Lease, { leaseName?: string; startedAt: number }>>) =>
    rows.map((row) => ("lease" in row ? row.lease.name : `request:${row.request.leaseName ?? row.request.startedAt}`));

  // not made yet: after the leases in use (a new lease's name is the latest), before the ones that wait or ended
  assert.deepEqual(names(orderLeaseRows(leases, [{ startedAt: 2 }, { startedAt: 1 }])), [
    "lease-a", "lease-b", "request:1", "request:2", "lease-w", "lease-old",
  ]);
  // made: among the leases in use, by its lease's name
  const during = names(orderLeaseRows(leases, [{ leaseName: "lease-ab", startedAt: 1 }]));
  assert.deepEqual(during, ["lease-a", "request:lease-ab", "lease-b", "lease-w", "lease-old"]);
  // ... which is where the lease is once it is held
  const after = names(orderLeaseRows([...leases, lease("lease-ab", "In-Use")], []));
  assert.equal(after.indexOf("lease-ab"), during.indexOf("request:lease-ab"));
  assert.deepEqual(names(orderLeaseRows([], [{ startedAt: 1 }])), ["request:1"]);
});

test("a lease that is being released keeps its place, whatever a listing says of it meanwhile", () => {
  const lease = (name: string, status: Lease["status"]): Lease => makeLease({ name, status });
  const names = (leases: Lease[], releasing?: Set<string>) =>
    orderLeaseRows(leases, [], releasing).map((row) => ("lease" in row ? row.lease.name : "request"));
  const before = names([lease("lease-a", "In-Use"), lease("lease-b", "In-Use"), lease("lease-c", "In-Use")]);
  assert.deepEqual(before, ["lease-a", "lease-b", "lease-c"]);
  // the history is shown, and the listing already has the lease as ended: without the mark it would go last
  const listed = [lease("lease-a", "In-Use"), lease("lease-b", "Ended"), lease("lease-c", "In-Use")];
  assert.deepEqual(names(listed), ["lease-a", "lease-c", "lease-b"]);
  assert.deepEqual(names(listed, new Set(["lease-b"])), before);
});
