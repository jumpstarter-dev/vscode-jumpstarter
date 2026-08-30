/**
 * Unit tests for manifest drafting (src/features/manifests/templates).
 * Run with `pnpm run test:unit` — plain node:test, no VS Code host.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildClientManifest,
  buildExporterManifest,
  buildExporterSetManifest,
  draftFileName,
  importableResources,
  looksLikeJumpstarterManifest,
  summarizeApplied,
  validateResourceName,
  yamlScalar,
} from "../../features/manifests/templates";
import { AppliedResource } from "../../types";

test("validateResourceName accepts Kubernetes names", () => {
  assert.equal(validateResourceName("belt-qemu-pool"), undefined);
  assert.equal(validateResourceName("exporter1"), undefined);
});

test("validateResourceName rejects what the API server would", () => {
  assert.ok(validateResourceName(""));
  assert.ok(validateResourceName("Uppercase"));
  assert.ok(validateResourceName("-leading"));
  assert.ok(validateResourceName("trailing-"));
  assert.ok(validateResourceName("has spaces"));
  assert.ok(validateResourceName("under_score"));
  assert.ok(validateResourceName("a".repeat(254)));
});

test("yamlScalar quotes values YAML would read as another type", () => {
  assert.equal(yamlScalar("qemu"), "qemu");
  assert.equal(yamlScalar("x86_64"), "x86_64");
  assert.equal(yamlScalar("true"), '"true"');
  assert.equal(yamlScalar("no"), '"no"');
  assert.equal(yamlScalar("2"), '"2"');
  assert.equal(yamlScalar("1.2.3"), '"1.2.3"');
  assert.equal(yamlScalar(""), '""');
  assert.equal(yamlScalar("- dash"), '"- dash"');
  assert.equal(yamlScalar(' padded '), '" padded "');
});

test("a client draft names the resource and its namespace", () => {
  const yaml = buildClientManifest({ name: "ci", namespace: "lab", labels: { team: "platform" } });
  assert.match(yaml, /^apiVersion: jumpstarter\.dev\/v1alpha1$/m);
  assert.match(yaml, /^kind: Client$/m);
  assert.match(yaml, /^ {2}name: ci$/m);
  assert.match(yaml, /^ {2}namespace: lab$/m);
  assert.match(yaml, /^ {4}team: platform$/m);
  assert.ok(looksLikeJumpstarterManifest(yaml));
});

test("a client draft with no labels suggests them in a comment", () => {
  const yaml = buildClientManifest({ name: "ci", namespace: "lab", labels: {} });
  assert.match(yaml, /# {3}team: platform/);
  // The suggestion must stay commented out, or an empty labels map is applied.
  assert.doesNotMatch(yaml, /^ {2}labels:$/m);
});

test("an exporter draft always ends up with labels, since selection needs them", () => {
  const yaml = buildExporterManifest({ name: "bench", namespace: "lab", labels: {} });
  assert.match(yaml, /^ {2}labels:$/m);
  assert.match(yaml, /^ {4}board: my-board$/m);
});

test("an exporter set draft keeps its selector a subset of the template labels", () => {
  const yaml = buildExporterSetManifest({
    name: "pool",
    namespace: "lab",
    labels: { board: "qemu", virtual: "true" },
    className: "qemu",
    minReplicas: 0,
    maxReplicas: 4,
    minAvailableReplicas: 1,
  });
  assert.match(yaml, /^apiVersion: virtualtarget\.jumpstarter\.dev\/v1alpha1$/m);
  assert.match(yaml, /^ {2}virtualTargetClassName: qemu$/m);
  assert.match(yaml, /^ {2}maxReplicas: 4$/m);
  // Both the selector and the template carry the same labels, quoted alike.
  assert.match(yaml, /matchLabels:\n {6}board: qemu\n {6}virtual: "true"/);
  assert.match(yaml, /labels:\n {8}board: qemu\n {8}virtual: "true"/);
});

test("looksLikeJumpstarterManifest ignores manifests for other groups", () => {
  assert.ok(looksLikeJumpstarterManifest("apiVersion: virtualtarget.jumpstarter.dev/v1alpha1"));
  assert.ok(!looksLikeJumpstarterManifest("apiVersion: apps/v1\nkind: Deployment"));
  assert.ok(!looksLikeJumpstarterManifest("kind: Client\n"));
  // A jumpstarter.dev value somewhere else in the file is not a manifest.
  assert.ok(!looksLikeJumpstarterManifest("image: quay.io/jumpstarter.dev/foo"));
});

test("draftFileName is stable per kind and name", () => {
  assert.equal(draftFileName("ExporterSet", "pool"), "exporterset-pool.yaml");
  assert.equal(draftFileName("Client", "ci"), "client-ci.yaml");
});

const applied = (kind: string, name: string, action: AppliedResource["action"]): AppliedResource => ({
  apiVersion: "jumpstarter.dev/v1alpha1",
  kind,
  name,
  namespace: "lab",
  action,
});

test("summarizeApplied names a single resource and counts several", () => {
  assert.equal(summarizeApplied([]), "nothing to apply");
  assert.equal(summarizeApplied([applied("Client", "ci", "created")]), "client/ci created");
  assert.equal(
    summarizeApplied([
      applied("Client", "ci", "created"),
      applied("Exporter", "bench", "created"),
      applied("Exporter", "old", "unchanged"),
    ]),
    "2 created, 1 unchanged",
  );
});

test("importableResources offers configs only for what actually changed", () => {
  const resources = [
    applied("Client", "ci", "created"),
    applied("Exporter", "bench", "configured"),
    applied("Exporter", "old", "unchanged"),
    applied("ExporterSet", "pool", "created"),
  ];
  assert.deepEqual(importableResources(resources), [
    { kind: "client", name: "ci" },
    { kind: "exporter", name: "bench" },
  ]);
});
