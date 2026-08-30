/**
 * Pure logic for the Leases tree view — no vscode imports, so everything in
 * this file is unit-testable under plain node (src/test/unit/leases.test.ts).
 *
 * The provider (provider.ts) maps the descriptors produced here onto
 * vscode.TreeItem objects.
 */

import {
  CliTreeNode,
  Lease,
  LeaseDevices,
  LeaseStatus,
  leaseRemainingSeconds,
} from "../../types";
import { CREATED_BY_TAG_KEY, CREATED_BY_TAG_VALUE } from "../../services/jmpProtocol";

// ---------------------------------------------------------------------------
// Descriptors (plain data; provider.ts turns them into TreeItems)
// ---------------------------------------------------------------------------

export interface LeaseRowDescriptor {
  /** Stable tree-item id (keeps expansion state across refreshes). */
  id: string;
  /** Short display name. */
  label: string;
  /** "exporter · status · remaining" */
  description: string;
  /** Multi-line plain-text tooltip. */
  tooltip: string;
  /** For view/item/context menu `when` clauses. */
  contextValue: string;
  /** Codicon id. */
  icon: string;
  /** Theme color id for the icon, if any. */
  iconColor: string | undefined;
  /** Only In-Use leases expand into a device tree. */
  expandable: boolean;
  createdByVscode: boolean;
}

export interface CommandDescriptor {
  /** CLI path relative to `j`, e.g. ["power", "on"]. */
  cliPath: string[];
  /** "j power on" */
  label: string;
  tooltip: string;
}

export interface DriverNodeDescriptor {
  /** Stable id fragment (the driver path). */
  id: string;
  /** Tail of the driver path, e.g. "power". */
  label: string;
  /** Tail of the class name, e.g. "MockPower". */
  description: string;
  tooltip: string;
  commands: CommandDescriptor[];
}

// ---------------------------------------------------------------------------
// Lease rows
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shorten UUID-style lease names to their first segment; ellipsize others. */
export function shortLeaseName(name: string): string {
  if (UUID_RE.test(name)) {
    return name.slice(0, 8);
  }
  if (name.length > 24) {
    return `${name.slice(0, 21)}…`;
  }
  return name;
}

/** "1h 30m" / "12m 5s" / "42s" for a non-negative span in seconds. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${sec}s`;
  }
  return `${sec}s`;
}

/** "12m 5s left", "overrun 3m 0s", or "" when the lease has not started. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) {
    return "";
  }
  if (seconds < 0) {
    return `overrun ${formatSpan(-seconds)}`;
  }
  return `${formatSpan(seconds)} left`;
}

/** True when the lease carries the jumpstarter.dev/created-by=vscode tag. */
export function isVscodeCreated(lease: Lease): boolean {
  return (lease.tags ?? {})[CREATED_BY_TAG_KEY] === CREATED_BY_TAG_VALUE;
}

/** Whether the lease is still active (shellable / extendable / releasable). */
export function isActiveStatus(status: LeaseStatus): boolean {
  return status === "In-Use" || status === "Waiting";
}

function statusFlag(status: LeaseStatus): string {
  switch (status) {
    case "In-Use":
      return "inUse";
    case "Waiting":
      return "waiting";
    default:
      return "ended";
  }
}

function statusIcon(status: LeaseStatus): { icon: string; color: string | undefined } {
  switch (status) {
    case "In-Use":
      return { icon: "vm-running", color: "charts.green" };
    case "Waiting":
      return { icon: "clock", color: "charts.yellow" };
    case "Expired":
      return { icon: "warning", color: "charts.orange" };
    case "Ended":
      return { icon: "circle-slash", color: "disabledForeground" };
    default:
      return { icon: "question", color: undefined };
  }
}

export function buildLeaseRow(lease: Lease, now: Date = new Date()): LeaseRowDescriptor {
  const vscodeCreated = isVscodeCreated(lease);
  const parts: string[] = [];
  if (lease.exporter_name) {
    parts.push(lease.exporter_name);
  }
  parts.push(lease.status);
  const remaining =
    lease.status === "In-Use" ? formatRemaining(leaseRemainingSeconds(lease, now)) : "";
  if (remaining) {
    parts.push(remaining);
  }

  const { icon, color } = statusIcon(lease.status);
  const tooltipLines = [
    lease.name,
    `Exporter: ${lease.exporter_name || lease.selector || "(selector)"}`,
    `Status: ${lease.status}`,
    `Duration: ${formatSpan(lease.duration)}`,
  ];
  if (lease.effective_begin_time) {
    tooltipLines.push(`Started: ${lease.effective_begin_time}`);
  }
  const tagEntries = Object.entries(lease.tags ?? {});
  if (tagEntries.length > 0) {
    tooltipLines.push(`Tags: ${tagEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (vscodeCreated) {
    tooltipLines.push("Created by the VS Code extension");
  }

  let contextValue = `jumpstarterLease-${statusFlag(lease.status)}`;
  if (vscodeCreated) {
    contextValue += "-vscode";
  }

  return {
    id: `jumpstarter.lease/${lease.namespace}/${lease.name}`,
    label: shortLeaseName(lease.name),
    description: parts.join(" · "),
    tooltip: tooltipLines.join("\n"),
    contextValue,
    // The zap icon doubles as the "created by this extension" badge.
    icon: vscodeCreated ? "zap" : icon,
    iconColor: color,
    expandable: lease.status === "In-Use",
    createdByVscode: vscodeCreated,
  };
}

const STATUS_RANK: Record<LeaseStatus, number> = {
  "In-Use": 0,
  Waiting: 1,
  Expired: 2,
  Ended: 3,
  Unknown: 4,
};

/** Active leases first, then by name for a stable order. */
export function sortLeases(leases: readonly Lease[]): Lease[] {
  return [...leases].sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5);
    return rank !== 0 ? rank : a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Device tree (jmp describe lease --devices)
// ---------------------------------------------------------------------------

/** Last segment of a dotted/slashed path ("dutlink.power" -> "power"). */
export function tailOfPath(p: string): string {
  const parts = p.split(/[./]/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/** Walk `root.subcommands` along `path`; undefined when any hop is missing. */
export function findCliNode(root: CliTreeNode, path: readonly string[]): CliTreeNode | undefined {
  let node: CliTreeNode = root;
  for (const seg of path) {
    const next = node.subcommands?.[seg];
    if (!next) {
      return undefined;
    }
    node = next;
  }
  return node;
}

function makeCommand(node: CliTreeNode, cliPath: string[]): CommandDescriptor {
  const lines: string[] = [];
  if (node.help) {
    lines.push(node.help.trim());
  }
  const params = node.params ?? [];
  if (params.length > 0) {
    lines.push(
      `Params: ${params
        .map((p) => (p.required ? `<${p.name}:${p.type}>` : `[${p.name}:${p.type}]`))
        .join(" ")}`,
    );
  }
  return {
    cliPath,
    label: `j ${cliPath.join(" ")}`,
    tooltip: lines.join("\n") || `j ${cliPath.join(" ")}`,
  };
}

/**
 * Flatten the runnable leaves of a cli_tree subtree. `basePath` is the path
 * of `node` relative to `j`. A driver whose node is itself a leaf yields a
 * single command.
 */
export function collectCommands(node: CliTreeNode, basePath: string[]): CommandDescriptor[] {
  const subs = node.subcommands ?? {};
  const keys = Object.keys(subs).sort();
  if (keys.length === 0) {
    return basePath.length > 0 ? [makeCommand(node, basePath)] : [];
  }
  const out: CommandDescriptor[] = [];
  for (const key of keys) {
    out.push(...collectCommands(subs[key], [...basePath, key]));
  }
  return out;
}

/**
 * Build driver nodes with their runnable commands. Each driver is matched to
 * its cli_tree subtree via driver_path, falling back to the dotted `path`
 * split into segments; drivers with no matching CLI subtree get no commands.
 */
export function buildDriverNodes(devices: LeaseDevices): DriverNodeDescriptor[] {
  const root = devices.cli_tree;
  return (devices.drivers ?? []).map((driver) => {
    let cliPath: string[] = driver.driver_path ?? [];
    let cliNode = root ? findCliNode(root, cliPath) : undefined;
    if ((!cliNode || cliPath.length === 0) && driver.path) {
      const fallback = driver.path.split(/[./]/).filter((s) => s.length > 0);
      const fallbackNode = root ? findCliNode(root, fallback) : undefined;
      if (fallbackNode && fallback.length > 0) {
        cliPath = fallback;
        cliNode = fallbackNode;
      }
    }
    const commands = cliNode && cliPath.length > 0 ? collectCommands(cliNode, cliPath) : [];
    const tooltipLines = [driver.class];
    if (driver.description) {
      tooltipLines.push(driver.description.trim());
    }
    if ((driver.methods ?? []).length > 0) {
      tooltipLines.push(`Methods: ${driver.methods.join(", ")}`);
    }
    return {
      id: driver.path || driver.driver_path.join("/"),
      label: tailOfPath(driver.path || driver.class),
      description: tailOfPath(driver.class),
      tooltip: tooltipLines.join("\n"),
      commands,
    };
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** QuickPick presets for Extend Lease; a Custom option is appended by the UI. */
export const EXTEND_DURATION_CHOICES = ["30m", "1h", "2h", "4h", "8h"] as const;

/**
 * Validate a jmp duration string: ordered d/h/m/s components, at least one,
 * e.g. "30m", "1h30m", "2d", "45s". Bare numbers are rejected.
 */
export function isValidDuration(input: string): boolean {
  const s = input.trim();
  return /^(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/.test(s) && /\d/.test(s);
}

/** Shell line for the clipboard action. */
export function buildExportLine(leaseName: string): string {
  return `export JMP_LEASE=${leaseName}`;
}

/** Tree view description: "alias" or "alias · incl. ended". */
export function viewDescription(client: string | null, includeEnded: boolean): string {
  if (!client) {
    return "";
  }
  return includeEnded ? `${client} · incl. ended` : client;
}
