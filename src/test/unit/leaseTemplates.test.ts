/**
 * Unit tests for the Lease Templates view's logic
 * (src/features/leaseTemplates/model.ts), against the listing of the real CLI
 * (src/test/fixtures/cli/lease-templates.json). Plain node:test.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  availableSummary,
  buildTemplateDocRow,
  buildTemplateForwardRow,
  buildTemplateMemberRow,
  buildTemplateRow,
  describeMembers,
  docLinks,
  durationChoices,
  formatDuration,
  isAvailable,
  optionalRoles,
  requestLabel,
  sortTemplates,
} from "../../features/leaseTemplates/model";
import { buildLeaseTemplateSections, renderDetailsHtml } from "../../features/details/render";
import { normalizeLeaseTemplate, parseLeaseTemplates } from "../../services/leaseProtocol";
import { fixtureJson } from "./cliFixtures";

const [ivi, bench] = parseLeaseTemplates(fixtureJson("lease-templates.json"));

test("a template's roles: a star marks an optional one", () => {
  assert.equal(describeMembers(ivi), "headunit, phone*, ecu");
  assert.deepEqual(optionalRoles(ivi).map((entry) => entry.member.name), ["phone"]);
});

test("availability: how many roles have an exporter, and whether the required ones do", () => {
  assert.equal(availableSummary(ivi), "2/3");
  // The only role without an exporter to lease is optional.
  assert.equal(isAvailable(ivi), true);
  const starved = normalizeLeaseTemplate({
    name: "starved",
    members: [{ member: { name: "headunit" }, available: 0 }, { member: { name: "phone", optional: true }, available: 4 }],
  });
  assert.ok(starved);
  assert.equal(availableSummary(starved), "1/2");
  assert.equal(isAvailable(starved), false);
  assert.equal(isAvailable({ ...ivi, members: [] }), false);
});

test("buildTemplateRow: roles, availability and description; the instructions as plain text in the tooltip", () => {
  const row = buildTemplateRow(ivi);
  assert.equal(row.label, "ivi");
  assert.equal(
    row.description,
    "headunit, phone*, ecu · 2/3 available · AAOS head unit, phone, and body ECU on one CAN bus",
  );
  assert.equal(row.contextValue, "jumpstarterLeaseTemplate");
  assert.deepEqual([row.icon, row.iconColor], ["layers", "charts.green"]);
  assert.match(row.tooltip, /Default duration: 2h/);
  assert.match(row.tooltip, /Forward bt: headunit\.rootcanal, phone\.controller/);
  assert.match(row.tooltip, /Docs: https:\/\/wiki\.example\.com\/labs\/ivi/);
  assert.match(row.tooltip, /Set the head unit to on before you start the phone\.$/);
  assert.doesNotMatch(`${row.description}${row.tooltip}`, /undefined|null/);
});

test("a role's row: how it finds its exporter, and how many there are to lease", () => {
  const rows = ivi.members.map((entry) => buildTemplateMemberRow(ivi, entry));
  assert.deepEqual(rows.map((row) => [row.label, row.description]), [
    ["headunit", "device-type=aaos-headunit · 2 available"],
    ["phone*", "device-type=phone · 0 available"],
    ["ecu", "exporter ecu-11 · 1 available"],
  ]);
  assert.equal(rows[1].iconColor, "disabledForeground");
  assert.match(rows[1].tooltip, /optional: a request may leave it out/);
  assert.match(rows[2].tooltip, /1 exporter you can lease now/);
});

test("forwards and documentation of a template", () => {
  assert.equal(buildTemplateForwardRow(ivi, ivi.forwards[0]).description, "headunit.rootcanal, phone.controller");
  assert.deepEqual(bench.forwards, []);
  assert.deepEqual(docLinks(ivi), ["https://wiki.example.com/labs/ivi"]);
  // Only web addresses are ever opened: a cluster may say anything.
  assert.deepEqual(
    docLinks({ ...ivi, docs: ["https://ok.example", "file:///etc/passwd", "javascript:alert(1)", "not a url", "vscode://x"] }),
    ["https://ok.example"],
  );
  assert.equal(buildTemplateDocRow(ivi, "https://ok.example", 0).label, "https://ok.example");
});

test("formatDuration: seconds as jmp reads a duration", () => {
  assert.equal(formatDuration(7200), "2h");
  assert.equal(formatDuration(5400), "1h30m");
  assert.equal(formatDuration(90061), "1d1h1m1s");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(Number.NaN), "");
});

test("durationChoices: the template's default first, and it sends no --duration", () => {
  const choices = durationChoices(ivi);
  assert.deepEqual(choices[0], { label: "Template default (2h)", description: "what the template says" });
  assert.deepEqual(choices.slice(1, -1).map((choice) => choice.duration), ["30m", "1h", "2h", "4h", "8h"]);
  assert.equal(choices[choices.length - 1].custom, true);
  // A template without a default has to be given a duration.
  const none = durationChoices({ ...ivi, default_duration: null });
  assert.equal(none[0].duration, "30m");
  assert.ok(none.every((choice) => choice.duration !== undefined || choice.custom));
});

test("requestLabel and order", () => {
  assert.equal(requestLabel("ivi", []), "ivi");
  assert.equal(requestLabel("ivi", ["phone", "ecu"]), "ivi without phone, ecu");
  assert.deepEqual(sortTemplates([ivi, bench]).map((template) => template.name), ["bench", "ivi"]);
});

test("details: a template's roles, forwards, links, and its instructions as plain text", () => {
  const sections = buildLeaseTemplateSections(ivi);
  assert.deepEqual(sections.map((section) => section.title), [
    "Lease template", "Roles", "Constraints", "Forwards", "Docs", "Instructions",
  ]);
  assert.deepEqual(sections[1].rows.map((row) => `${row.label}: ${row.value}`), [
    "headunit: device-type=aaos-headunit · 2 available",
    "phone*: device-type=phone · 0 available",
    "ecu: exporter ecu-11 · 1 available",
  ]);
  assert.deepEqual(sections[2].rows, [{ label: "headunit, ecu", value: "same bus", mono: true }]);
  assert.equal(sections[5].text, "Set the head unit to on before you start the phone.");

  // Whatever an administrator wrote is text, never markup.
  const html = renderDetailsHtml({
    kind: "leaseTemplate",
    template: { ...ivi, instructions: "<script>alert(1)</script>\nsecond line", description: "<b>bold</b>" },
  });
  assert.match(html, /<pre class="text">&lt;script&gt;alert\(1\)&lt;\/script&gt;\nsecond line<\/pre>/);
  assert.doesNotMatch(html, /<script>|<b>bold/);
  assert.match(html, /<h1>ivi<\/h1>/);
});
