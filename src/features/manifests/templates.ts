/**
 * Manifest drafting — pure text generation for the cluster resources the
 * extension can create (VS Code-free, unit-testable).
 *
 * A draft is ordinary YAML written to a file and opened in the editor, so the
 * shape a wizard cannot ask about — an exporter's drivers, a set's template —
 * can be filled in before anything reaches the cluster. Comments in the
 * generated text are part of that: they are what the reader edits against.
 */

import { AppliedResource } from "../../types";

export const MANIFEST_API_VERSION = "jumpstarter.dev/v1alpha1";
export const VIRTUAL_TARGET_API_VERSION = "virtualtarget.jumpstarter.dev/v1alpha1";

/** Kinds the new-resource wizards can draft. */
export type DraftKind = "Client" | "Exporter" | "ExporterSet";

export interface DraftIdentity {
  name: string;
  namespace: string;
  labels?: Record<string, string>;
}

export interface ExporterSetDraft extends DraftIdentity {
  /** VirtualTargetClass that provisions the members. */
  className: string;
  minReplicas: number;
  maxReplicas: number;
  minAvailableReplicas: number;
}

/** A Kubernetes name: lowercase alphanumerics and dashes, dash-free at the ends. */
export function validateResourceName(value: string): string | undefined {
  const name = value.trim();
  if (name.length === 0) {
    return "Enter a name";
  }
  if (name.length > 253) {
    return "Name must be 253 characters or fewer";
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return "Use lowercase letters, digits and dashes (must start and end with a letter or digit)";
  }
  return undefined;
}

/** Render a scalar, quoting whatever YAML would otherwise read as a non-string. */
export function yamlScalar(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  const needsQuotes =
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /[:#]\s/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[+-]?(\d|\.\d)/.test(value) ||
    value !== value.trim();
  return needsQuotes ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function labelBlock(labels: Record<string, string> | undefined, indent: string): string[] {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) {
    return [];
  }
  return [
    `${indent}labels:`,
    ...entries.map(([key, value]) => `${indent}  ${yamlScalar(key)}: ${yamlScalar(value)}`),
  ];
}

function header(kind: DraftKind, apiVersion: string, identity: DraftIdentity): string[] {
  return [
    `apiVersion: ${apiVersion}`,
    `kind: ${kind}`,
    "metadata:",
    `  name: ${yamlScalar(identity.name)}`,
    `  namespace: ${yamlScalar(identity.namespace)}`,
    ...labelBlock(identity.labels, "  "),
  ];
}

/**
 * A Client, which is an identity: the controller answers a created Client with
 * a token, which `jmp admin import client` then fetches into a local config.
 */
export function buildClientManifest(identity: DraftIdentity): string {
  return [
    "# A Jumpstarter client identity.",
    "#",
    "# Applying this creates the client in the cluster; the controller then",
    "# issues its credentials, which you import into a local config to use it.",
    ...header("Client", MANIFEST_API_VERSION, identity),
    ...(Object.keys(identity.labels ?? {}).length === 0
      ? ["  # labels:", "  #   team: platform"]
      : []),
    "",
  ].join("\n");
}

/**
 * An Exporter, which is the cluster-side identity of a machine that will run
 * `jmp run`. What it exports is decided by the exporter's own local config,
 * not here; the labels are what clients select it by.
 */
export function buildExporterManifest(identity: DraftIdentity): string {
  return [
    "# A Jumpstarter exporter identity.",
    "#",
    "# The labels are how clients select this exporter, so give it enough of",
    "# them to be found: what the hardware is, and where it lives.",
    "#",
    "# The drivers it exports come from the exporter's own config file on the",
    "# machine that runs it, which `jmp admin import exporter` writes for you",
    "# once this exists.",
    ...header("Exporter", MANIFEST_API_VERSION, identity),
    ...(Object.keys(identity.labels ?? {}).length === 0
      ? ["  labels:", "    board: my-board"]
      : []),
    "",
  ].join("\n");
}

/**
 * An ExporterSet: a pool of exporters a provisioner creates on demand, so the
 * template is the interesting part and is left for the editor to fill in.
 */
export function buildExporterSetManifest(draft: ExporterSetDraft): string {
  const templateLabels = Object.keys(draft.labels ?? {}).length > 0 ? draft.labels : { board: "my-board" };
  return [
    "# A pool of exporters, provisioned on demand by a VirtualTargetClass.",
    "#",
    "# selector matches the exporters this set owns; template.metadata.labels",
    "# are stamped onto each member the provisioner creates, so the selector",
    "# has to be a subset of them or the set will never find its own members.",
    ...header("ExporterSet", VIRTUAL_TARGET_API_VERSION, draft),
    "spec:",
    `  virtualTargetClassName: ${yamlScalar(draft.className)}`,
    `  minReplicas: ${draft.minReplicas}`,
    `  maxReplicas: ${draft.maxReplicas}`,
    "  # Members kept ready and unleased, so a lease does not wait on a boot.",
    `  minAvailableReplicas: ${draft.minAvailableReplicas}`,
    "  scaleDownCooldown: 5m",
    "  recycleStrategy: ExitAndReplace",
    "  selector:",
    "    matchLabels:",
    ...Object.entries(templateLabels ?? {}).map(
      ([key, value]) => `      ${yamlScalar(key)}: ${yamlScalar(value)}`,
    ),
    "  template:",
    "    metadata:",
    "      labels:",
    ...Object.entries(templateLabels ?? {}).map(
      ([key, value]) => `        ${yamlScalar(key)}: ${yamlScalar(value)}`,
    ),
    "    spec:",
    "      drivers:",
    "        # The drivers every member of this pool exports.",
    "        - name: power",
    "          type: jumpstarter_driver_power.driver.MockPower",
    "",
  ].join("\n");
}

/** File name for a draft of this kind, unique enough to reopen by name. */
export function draftFileName(kind: DraftKind, name: string): string {
  return `${kind.toLowerCase()}-${name}.yaml`;
}

/**
 * Whether a document is a Jumpstarter manifest, and so worth offering to
 * apply. Deliberately loose: it gates a button, and the CLI validates for
 * real before anything is sent.
 */
export function looksLikeJumpstarterManifest(text: string): boolean {
  return /^\s*apiVersion:\s*["']?(\w+\.)*jumpstarter\.dev\//m.test(text);
}

/** "2 created, 1 unchanged" — what an apply did, for a notification. */
export function summarizeApplied(applied: readonly AppliedResource[]): string {
  if (applied.length === 0) {
    return "nothing to apply";
  }
  if (applied.length === 1) {
    const [only] = applied;
    return `${only.kind.toLowerCase()}/${only.name} ${only.action}`;
  }
  const counts = new Map<string, number>();
  for (const resource of applied) {
    counts.set(resource.action, (counts.get(resource.action) ?? 0) + 1);
  }
  return [...counts.entries()].map(([action, count]) => `${count} ${action}`).join(", ");
}

/** Resources an apply created or updated that have a config to import. */
export function importableResources(
  applied: readonly AppliedResource[],
): { kind: "client" | "exporter"; name: string }[] {
  return applied
    .filter((resource) => resource.action !== "unchanged")
    .filter((resource) => resource.kind === "Client" || resource.kind === "Exporter")
    .map((resource) => ({
      kind: resource.kind.toLowerCase() as "client" | "exporter",
      name: resource.name,
    }));
}
