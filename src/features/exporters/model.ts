/**
 * Pure (VS Code-free) logic for the Exporters view: status categorization,
 * tree item specs (label/description/tooltip/icon/context value), label
 * selector parsing/matching, label autocomplete collection and duration
 * validation. Everything here is unit-testable under plain Node.
 */

import { Exporter, ExporterStatus, leaseRemainingSeconds } from "../../types";

// ---------------------------------------------------------------------------
// Status categorization + icons
// ---------------------------------------------------------------------------

/** Coarse status bucket used for icon/color and context value. */
export type ExporterCategory = "available" | "leased" | "offline" | "failed" | "unknown";

export function categorizeExporter(status: ExporterStatus, online: boolean): ExporterCategory {
  switch (status) {
    case "AVAILABLE":
      return online ? "available" : "offline";
    case "LEASE_READY":
    case "BEFORE_LEASE_HOOK":
    case "AFTER_LEASE_HOOK":
      return "leased";
    case "BEFORE_LEASE_HOOK_FAILED":
    case "AFTER_LEASE_HOOK_FAILED":
      return "failed";
    case "OFFLINE":
      return "offline";
    default:
      return online ? "unknown" : "offline";
  }
}

/** Codicon id + theme color id for a status category. */
export interface IconSpec {
  /** Codicon name (without the $() wrapper). */
  id: string;
  /** vscode.ThemeColor id, or undefined for the default foreground. */
  colorId: string | undefined;
}

const CATEGORY_ICONS: Record<ExporterCategory, IconSpec> = {
  available: { id: "circle-filled", colorId: "charts.green" },
  leased: { id: "circle-filled", colorId: "charts.yellow" },
  offline: { id: "circle-slash", colorId: "disabledForeground" },
  failed: { id: "error", colorId: "charts.red" },
  unknown: { id: "question", colorId: "disabledForeground" },
};

export function iconForCategory(category: ExporterCategory): IconSpec {
  return CATEGORY_ICONS[category];
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

/** labels merged over deprecated_labels (current labels win). */
export function effectiveLabels(exporter: Exporter): Record<string, string> {
  return { ...exporter.deprecated_labels, ...exporter.labels };
}

export function formatLabels(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(", ");
}

/** Sorted unique label keys across the given exporters (for autocomplete). */
export function collectLabelKeys(exporters: readonly Exporter[]): string[] {
  const keys = new Set<string>();
  for (const e of exporters) {
    for (const k of Object.keys(effectiveLabels(e))) {
      keys.add(k);
    }
  }
  return [...keys].sort();
}

/** Sorted unique values seen for a label key across the given exporters. */
export function collectLabelValues(exporters: readonly Exporter[], key: string): string[] {
  const values = new Set<string>();
  for (const e of exporters) {
    const v = effectiveLabels(e)[key];
    if (v !== undefined) {
      values.add(v);
    }
  }
  return [...values].sort();
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export interface SelectorPair {
  key: string;
  value: string;
}

/**
 * Parse "k=v,k2=v2" into pairs. Returns [] for empty/whitespace input and
 * null when any comma-separated part is not a plain key=value.
 */
export function parseSelector(selector: string): SelectorPair[] | null {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const pairs: SelectorPair[] = [];
  for (const part of trimmed.split(",")) {
    const m = /^\s*([^=,\s]+)\s*=\s*([^=,\s]+)\s*$/.exec(part);
    if (!m) {
      return null;
    }
    pairs.push({ key: m[1], value: m[2] });
  }
  return pairs;
}

export function buildSelector(pairs: readonly SelectorPair[]): string {
  return pairs.map((p) => `${p.key}=${p.value}`).join(",");
}

export function exporterMatchesSelector(
  exporter: Exporter,
  pairs: readonly SelectorPair[],
): boolean {
  const labels = effectiveLabels(exporter);
  return pairs.every((p) => labels[p.key] === p.value);
}

/** Exporters matching every pair; an empty pair list matches everything. */
export function filterExportersBySelector(
  exporters: readonly Exporter[],
  pairs: readonly SelectorPair[],
): Exporter[] {
  return exporters.filter((e) => exporterMatchesSelector(e, pairs));
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/** Preset durations offered in the acquire QuickPick. */
export const DURATION_PRESETS = ["15m", "30m", "1h", "4h", "8h"] as const;

/**
 * True for CLI-style duration strings: one or more of Nd/Nh/Nm/Ns in that
 * order, e.g. "30m", "1h", "1h30m", "2d4h".
 */
export function isValidDuration(input: string): boolean {
  const s = input.trim();
  return /^(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/.test(s) && /\d/.test(s);
}

/** "5400" seconds -> "1h30m"; sub-minute -> "45s"; negative -> "0s". */
export function formatDurationShort(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (parts.length === 0) {
    parts.push(`${s % 60}s`);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Tree item specs
// ---------------------------------------------------------------------------

/** Everything the TreeDataProvider needs to render one exporter row. */
export interface ExporterItemSpec {
  /** Stable id: namespace/name. */
  id: string;
  label: string;
  description: string;
  /** Markdown source for the tooltip. */
  tooltipMarkdown: string;
  /** "exporter-available" | "exporter-leased" | ... — drives inline actions. */
  contextValue: string;
  icon: IconSpec;
  category: ExporterCategory;
}

function escapeMarkdownCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function buildExporterTooltipMarkdown(exporter: Exporter, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push(`**${exporter.name}**  \n\`${exporter.namespace}\``);
  lines.push("");
  lines.push(
    `Status: \`${exporter.status}\` (${exporter.online ? "online" : "offline"}` +
      `${exporter.enabled ? "" : ", disabled"})`,
  );
  const lease = exporter.lease;
  if (lease) {
    lines.push("");
    lines.push(`Held by: \`${lease.client}\` — lease \`${lease.name}\` (${lease.status})`);
    const remaining = leaseRemainingSeconds(lease, now);
    if (remaining !== null && remaining > 0) {
      lines.push("");
      lines.push(`Time remaining: ${formatDurationShort(remaining)}`);
    }
  }
  const labels = effectiveLabels(exporter);
  const keys = Object.keys(labels).sort();
  if (keys.length > 0) {
    lines.push("");
    lines.push("| Label | Value |");
    lines.push("| --- | --- |");
    for (const k of keys) {
      lines.push(`| ${escapeMarkdownCell(k)} | ${escapeMarkdownCell(labels[k])} |`);
    }
  }
  return lines.join("\n");
}

export function buildExporterItemSpec(exporter: Exporter, now: Date = new Date()): ExporterItemSpec {
  const category = categorizeExporter(exporter.status, exporter.online);
  const parts: string[] = [];
  if (exporter.lease) {
    parts.push(`leased by ${exporter.lease.client}`);
  } else if (category !== "available") {
    parts.push(exporter.status.toLowerCase().replace(/_/g, " "));
  }
  const labelText = formatLabels(effectiveLabels(exporter));
  if (labelText.length > 0) {
    parts.push(labelText);
  }
  return {
    id: `${exporter.namespace}/${exporter.name}`,
    label: exporter.name,
    description: parts.join(" · "),
    tooltipMarkdown: buildExporterTooltipMarkdown(exporter, now),
    contextValue: `exporter-${category}`,
    icon: iconForCategory(category),
    category,
  };
}

/** Name-sorted copy (stable, locale-independent). */
export function sortExporters(exporters: readonly Exporter[]): Exporter[] {
  return [...exporters].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
