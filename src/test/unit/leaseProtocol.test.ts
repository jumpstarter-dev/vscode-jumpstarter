/**
 * Unit tests for reading what the CLI prints for leases with members, lease
 * templates and ports (src/services/leaseProtocol.ts), against the output of
 * the real CLI (src/test/fixtures/cli). Plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildCreateTemplateLeaseArgs,
  buildDescribeLeaseTemplateArgs,
  buildGetExporterPortsArgs,
  buildGetLeaseTemplatesArgs,
  buildRoleDriversCommand,
  leaseTemplatesUnavailable,
  normalizeLease,
  normalizeLeaseTemplate,
  parseExporterPorts,
  parseLeases,
  parseLeaseTemplates,
  parseRoleDrivers,
  ROLE_DRIVERS_SCRIPT,
} from "../../services/leaseProtocol";
import { JmpError } from "../../services/jmpProtocol";
import { fixtureJson, fixtureText } from "./cliFixtures";

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

test("parseLeases: a lease with members has roles, a template and forwards, and no exporter", () => {
  const leases = parseLeases(fixtureJson("leases.json"));
  assert.deepEqual(
    leases.map((lease) => lease.name),
    ["lease-9m2qd", "lease-degraded", "lease-omitted", "lease-pending", "lease-scalar"],
  );
  const lease = leases[0];
  assert.equal(lease.exporter, "");
  assert.equal(lease.exporter_name, null);
  assert.equal(lease.status, "In-Use");
  assert.deepEqual(lease.template, { template: "ivi", generation: 3 });
  assert.deepEqual(
    lease.members?.map((member) => [member.name, member.optional]),
    [["phone", true], ["headunit", false]],
  );
  assert.deepEqual(
    lease.member_statuses?.map((status) => [status.name, status.state, status.exporter]),
    [["phone", "Bound", "rack3-phone-4"], ["headunit", "Bound", "rack3-hu-2"]],
  );
  assert.deepEqual(lease.forwards, [
    {
      name: "bt",
      endpoints: [
        { member_name: "headunit", port_name: "rootcanal" },
        { member_name: "phone", port_name: "controller" },
      ],
    },
  ]);
  assert.equal(lease.forward_statuses?.[0].state, "Connected");
  assert.deepEqual(
    lease.forward_statuses?.[0].ends?.map((end) => [end.member_name, end.state]),
    [["headunit", "Connected"], ["phone", "Connected"]],
  );
});

test("parseLeases: a degraded lease says so, with the lost role's reason and the failed forward's ends", () => {
  const lease = parseLeases(fixtureJson("leases.json"))[1];
  assert.equal(lease.status, "Degraded");
  assert.equal(lease.template, null);
  const phone = lease.member_statuses?.find((status) => status.name === "phone");
  assert.deepEqual(phone, {
    name: "phone",
    state: "Lost",
    exporter: "rack3-phone-4",
    reason: "ExporterOffline",
    message: "the exporter went offline",
  });
  assert.deepEqual(lease.forward_statuses?.[0], {
    name: "bt",
    state: "Failed",
    message: "member phone is lost",
    ends: [
      { member_name: "headunit", state: "Ready", message: null },
      { member_name: "phone", state: "Failed", message: "the exporter went offline" },
    ],
  });
});

test("parseLeases: a lease of one exporter is as it always was, with none of the member fields", () => {
  const lease = parseLeases(fixtureJson("leases.json"))[4];
  // `exporter_name` is the exporter that was asked for by name (none: this lease is by selector);
  // `exporter` is the one that is bound.
  assert.equal(lease.exporter_name, null);
  assert.equal(lease.exporter, "bench-1");
  assert.equal(lease.selector, "board=rpi4");
  for (const key of ["members", "member_statuses", "template", "constraints", "forwards", "forward_statuses"]) {
    assert.ok(!(key in lease), `${key} must be absent from a lease of one exporter`);
  }
});

test("normalizeLease: the output of a CLI from before members is read unchanged", () => {
  const old = {
    name: "lease-1",
    namespace: "lab",
    selector: "board=rpi4",
    exporter: "lab/bench-1",
    exporter_name: "bench-1",
    client: "fake",
    duration: 3600,
    effective_begin_time: "2026-01-01T00:00:00Z",
    effective_end_time: null,
    begin_time: "2026-01-01T00:00:00Z",
    tags: { "created-by": "vscode" },
    context: {},
    conditions: [],
    status: "In-Use",
  };
  assert.deepEqual(normalizeLease(old), old);
});

test("normalizeLease: missing and malformed fields become safe values, never undefined", () => {
  const lease = normalizeLease({ name: "bare" });
  assert.deepEqual(lease, {
    name: "bare",
    namespace: "",
    selector: "",
    exporter: "",
    exporter_name: null,
    client: "",
    duration: 0,
    effective_begin_time: null,
    effective_end_time: null,
    begin_time: null,
    tags: {},
    context: {},
    conditions: [],
    status: "Unknown",
  });

  const odd = normalizeLease({
    name: "odd",
    exporter_name: 7,
    duration: "long",
    tags: ["x"],
    conditions: null,
    members: [{ name: "phone" }, { selector: "no-name" }, "junk", null],
    member_statuses: [{ name: "phone" }, { state: "Bound" }],
    template: { generation: 2 },
    forwards: [{ name: "bt", endpoints: [{ member_name: "phone" }, { member_name: "a", port_name: "b" }] }, {}],
    forward_statuses: "none",
  });
  assert.equal(odd?.exporter_name, null);
  assert.equal(odd?.duration, 0);
  assert.deepEqual(odd?.tags, {});
  assert.deepEqual(odd?.members?.map((member) => member.name), ["phone"]);
  assert.deepEqual(odd?.member_statuses, [
    { name: "phone", state: "Pending", exporter: null, reason: null, message: null },
  ]);
  assert.equal(odd?.template, null);
  assert.deepEqual(odd?.forwards, [{ name: "bt", endpoints: [{ member_name: "a", port_name: "b" }] }]);
  assert.deepEqual(odd?.forward_statuses, []);
});

test("normalizeLease: fields and states of a later CLI are kept as they are", () => {
  const lease = normalizeLease({
    name: "future",
    status: "Hibernating",
    shiny_new_field: { a: 1 },
    members: [{ name: "phone", shiny: true }],
    member_statuses: [{ name: "phone", state: "Migrating", exporter: "p-1" }],
  }) as unknown as Record<string, unknown>;
  assert.equal(lease.status, "Hibernating");
  assert.deepEqual(lease.shiny_new_field, { a: 1 });
  assert.equal((lease.member_statuses as { state: string }[])[0].state, "Migrating");
});

test("parseLeases: something that is not a list of leases is no leases", () => {
  assert.deepEqual(parseLeases(null), []);
  assert.deepEqual(parseLeases({}), []);
  assert.deepEqual(parseLeases({ leases: "x" }), []);
  assert.deepEqual(parseLeases({ leases: [null, 4, { namespace: "no name" }] }), []);
});

// ---------------------------------------------------------------------------
// Lease templates
// ---------------------------------------------------------------------------

test("parseLeaseTemplates: the listing of the real CLI", () => {
  const templates = parseLeaseTemplates(fixtureJson("lease-templates.json"));
  assert.deepEqual(templates.map((template) => template.name), ["ivi", "bench"]);
  const ivi = templates[0];
  assert.equal(ivi.description, "AAOS head unit, phone, and body ECU on one CAN bus");
  assert.deepEqual(ivi.docs, ["https://wiki.example.com/labs/ivi"]);
  assert.equal(ivi.instructions, "Set the head unit to on before you start the phone.\n");
  assert.equal(ivi.default_duration, 7200);
  assert.deepEqual(
    ivi.members.map((entry) => [entry.member.name, entry.member.optional, entry.available]),
    [["headunit", false, 2], ["phone", true, 0], ["ecu", false, 1]],
  );
  assert.equal(ivi.members[2].member.exporter_name, "ecu-11");
  assert.deepEqual(ivi.forwards.map((forward) => forward.name), ["bt"]);
  // A template without forwards prints no `forwards` at all.
  assert.deepEqual(templates[1].forwards, []);
});

test("normalizeLeaseTemplate: `jmp describe lease-template -o json` is one template of the same shape", () => {
  const template = normalizeLeaseTemplate(fixtureJson("lease-template.json"));
  assert.equal(template?.name, "ivi");
  assert.equal(template?.members.length, 3);
});

test("normalizeLeaseTemplate: a bare template is safe to render", () => {
  assert.deepEqual(normalizeLeaseTemplate({ name: "bare" }), {
    name: "bare",
    namespace: "",
    description: "",
    docs: [],
    image: null,
    instructions: null,
    members: [],
    constraints: [],
    default_duration: null,
    default_shared_with: [],
    forwards: [],
  });
  assert.equal(normalizeLeaseTemplate({ description: "no name" }), undefined);
  assert.deepEqual(parseLeaseTemplates({ lease_templates: [{ name: "a", members: [{ available: 3 }, { member: { name: "r" }, available: -1 }] }] })[0].members, [
    { member: { name: "r", selector: null, exporter_name: null, optional: false, allow_disabled: false, excluded: false }, available: 0 },
  ]);
  assert.deepEqual(parseLeaseTemplates(undefined), []);
});

test("template arguments: listing, describing and requesting", () => {
  assert.deepEqual(buildGetLeaseTemplatesArgs("lab"), ["get", "lease-templates", "-o", "json", "--client", "lab"]);
  assert.deepEqual(buildDescribeLeaseTemplateArgs("lab", "ivi"), [
    "describe", "lease-template", "ivi", "-o", "json", "--client", "lab",
  ]);
  assert.deepEqual(buildCreateTemplateLeaseArgs("lab", { template: "ivi" }), [
    "create", "lease", "--client", "lab", "-t", "ivi", "--tag", "created-by=vscode", "-o", "name",
  ]);
  assert.deepEqual(
    buildCreateTemplateLeaseArgs("lab", {
      template: "ivi",
      without: ["phone", "phone", "tablet"],
      memberSelectors: { headunit: " soc=sa8775p " },
      duration: "4h",
    }),
    [
      "create", "lease", "--client", "lab", "-t", "ivi",
      "--without", "phone", "--without", "tablet",
      "--member", "headunit=soc=sa8775p",
      "--duration", "4h",
      "--tag", "created-by=vscode",
      "-o", "name",
    ],
  );
});

test("template arguments: what is not a role is refused before the CLI sees it", () => {
  assert.throws(() => buildCreateTemplateLeaseArgs("lab", { template: "" }), JmpError);
  assert.throws(() => buildCreateTemplateLeaseArgs("lab", { template: "ivi", without: ["--force"] }), JmpError);
  assert.throws(() => buildCreateTemplateLeaseArgs("lab", { template: "ivi", without: ["Phone"] }), JmpError);
  assert.throws(
    () => buildCreateTemplateLeaseArgs("lab", { template: "ivi", memberSelectors: { phone: " " } }),
    JmpError,
  );
});

test("leaseTemplatesUnavailable: an older jmp and an older controller are not errors", () => {
  assert.match(
    leaseTemplatesUnavailable({
      kind: "usage",
      message: "Error: No such command 'lease-templates'.",
      stderr: "Usage: jmp get [OPTIONS] COMMAND [ARGS]...\n\nError: No such command 'lease-templates'.\n",
    }) ?? "",
    /upgrade the Jumpstarter CLI/,
  );
  assert.match(
    leaseTemplatesUnavailable({
      kind: "unknown",
      message: "Error: the controller is too old for lease templates: upgrade the controller",
    }) ?? "",
    /controller .* too old/,
  );
  // Anything else is a failure like any other.
  assert.equal(leaseTemplatesUnavailable({ kind: "connection-failed", message: "failed to connect" }), undefined);
  assert.equal(leaseTemplatesUnavailable({ kind: "auth-expired", message: "token is expired" }), undefined);
});

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

test("parseExporterPorts: the ports each exporter declares, by exporter", () => {
  assert.deepEqual(buildGetExporterPortsArgs("lab"), [
    "get", "exporters", "--with", "ports", "-o", "json", "--client", "lab",
  ]);
  assert.deepEqual(parseExporterPorts(fixtureJson("exporters-ports.json")), {
    "rack3-hu-2": [{ name: "rootcanal", direction: "provides", protocol: "rootcanal-hci" }],
    "rack3-phone-4": [
      { name: "controller", direction: "requires", protocol: "rootcanal-hci" },
      { name: "can0", direction: "connects", attachment: "wired", transport: "frame" },
    ],
  });
  // An older CLI's exporters have no ports at all.
  assert.deepEqual(parseExporterPorts({ exporters: [{ name: "bench-1", labels: {} }] }), {});
  assert.deepEqual(parseExporterPorts("nonsense"), {});
});

// ---------------------------------------------------------------------------
// The drivers of each role
// ---------------------------------------------------------------------------

test("parseRoleDrivers: what the script printed against real driver sessions", () => {
  const roles = parseRoleDrivers(fixtureText("role-drivers.txt"));
  assert.deepEqual(Object.keys(roles), ["headunit", "phone"]);
  const phone = roles.phone;
  assert.ok("driver_tree" in phone);
  assert.deepEqual(
    phone.driver_tree.drivers.map((driver) => driver.driver_path),
    [[], ["power"]],
  );
  assert.ok(phone.driver_tree.cli_tree.subcommands.power.subcommands.on);
});

test("parseRoleDrivers: only what is between the markers is read", () => {
  const chatter =
    'INFO connecting\n<<<jumpstarter-vscode-roles\n{"roles": {"phone": {"error": "ConnectionError: gone"}, "x": 3, "y": {}}}\njumpstarter-vscode-roles>>>\nbye\n';
  assert.deepEqual(parseRoleDrivers(chatter), { phone: { error: "ConnectionError: gone" } });
  assert.throws(() => parseRoleDrivers("Error: lease not found\n"), JmpError);
  assert.throws(
    () => parseRoleDrivers("<<<jumpstarter-vscode-roles\n{not json\njumpstarter-vscode-roles>>>\n"),
    JmpError,
  );
});

test("the role drivers script is one argument for the session's own interpreter", () => {
  assert.deepEqual(buildRoleDriversCommand("/venv/bin/python"), ["/venv/bin/python", "-c", ROLE_DRIVERS_SCRIPT]);
  // It reads the roles where `jmp shell` describes them, with the CLI's own description of a client.
  assert.match(ROLE_DRIVERS_SCRIPT, /lease_members_from_env/);
  assert.match(ROLE_DRIVERS_SCRIPT, /describe_client/);
});
