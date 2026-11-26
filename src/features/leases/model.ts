/**
 * Pure logic for the Leases tree view — no vscode imports, so everything in
 * this file is unit-testable under plain node (src/test/unit/leases.test.ts).
 *
 * The provider (provider.ts) maps the descriptors produced here onto
 * vscode.TreeItem objects.
 */

import {
  CliParam,
  CliTreeNode,
  Lease,
  LeaseDriverTree,
  LeaseStatus,
  isLeaseUsable,
  leaseRemainingSeconds,
} from "../../types";
import {
  DirectionLookup,
  exporterSetOf,
  isDegraded,
  isMemberLease,
  leaseExporter,
  leaseTarget,
  memberTooltipLines,
} from "./members";
import {
  CREATED_BY_TAG_KEY,
  CREATED_BY_TAG_VALUE,
  LEGACY_CREATED_BY_TAG_KEY,
} from "../../services/jmpProtocol";

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
  /**
   * A lease in use expands into its driver tree; a lease with members expands
   * into its roles and forwards in any state (a role that is waiting says so).
   */
  expandable: boolean;
  createdByVscode: boolean;
}

export interface CommandDescriptor {
  /** CLI path relative to `j`, e.g. ["power", "on"]. */
  cliPath: string[];
  /** "j power on"; "j phone power on" for a role of a lease with members. */
  label: string;
  /** The role the command addresses, for a lease with members (`j ROLE ...`). */
  role?: string;
  tooltip: string;
  /** Parameters the command accepts, in Click's declaration order. */
  params: CliParam[];
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
  /** The driver's path in the session, root first, e.g. ["cuttlefish", "hmi"]. */
  driverPath: string[];
  /** The full name of the driver's client class. */
  driverClass: string;
  /** The role the driver belongs to, for a lease with members. */
  role?: string;
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

/** True when the lease carries the created-by=vscode tag (under its current or its earlier key). */
export function isVscodeCreated(lease: Lease): boolean {
  const tags = lease.tags ?? {};
  return (
    tags[CREATED_BY_TAG_KEY] === CREATED_BY_TAG_VALUE ||
    tags[LEGACY_CREATED_BY_TAG_KEY] === CREATED_BY_TAG_VALUE
  );
}

/** Whether the lease is still active (shellable / extendable / releasable). */
export function isActiveStatus(status: LeaseStatus): boolean {
  return isLeaseUsable(status) || status === "Waiting";
}

function statusFlag(status: LeaseStatus): string {
  switch (status) {
    case "In-Use":
    // A degraded lease is still held and its bound roles still work: every
    // action of a lease in use applies to it.
    case "Degraded":
      return "inUse";
    case "Waiting":
      return "waiting";
    default:
      return "ended";
  }
}

/**
 * Codicon and color for a lease status.
 *
 * A lease is a hold on an exporter, so it is drawn as a lock: closed while the
 * hold is yours, open before and after. Exported so the Administration view
 * draws a lease the way this view does — the same fact should not have two
 * icons depending on where you look at it.
 */
export function leaseStatusIcon(status: LeaseStatus): { icon: string; color: string | undefined } {
  switch (status) {
    case "In-Use":
      return { icon: "lock", color: "charts.green" };
    case "Degraded":
      // Held, with a role that lost its exporter: the lock, in the warning colour.
      return { icon: "lock", color: "list.warningForeground" };
    case "Waiting":
      // Requested, not yet granted: the lock is not closed yet. Blue is the
      // pending colour throughout, matching a lease still being acquired.
      return { icon: "unlock", color: "charts.blue" };
    case "Expired":
      // Not charts.orange: themes may give it an alpha, and a lease that has
      // run past its time is the one state that must not fade into the row.
      return { icon: "lock", color: "charts.red" };
    case "Ended":
      return { icon: "unlock", color: "disabledForeground" };
    default:
      return { icon: "question", color: undefined };
  }
}

export { leaseTarget };

export function buildLeaseRow(
  lease: Lease,
  now: Date = new Date(),
  direction?: DirectionLookup,
): LeaseRowDescriptor {
  const vscodeCreated = isVscodeCreated(lease);
  const members = isMemberLease(lease);
  // A lease whose role lost its exporter is Degraded, whatever word the CLI has for it.
  const degraded = isDegraded(lease);
  const status: LeaseStatus = degraded ? "Degraded" : lease.status;
  const parts: string[] = [];
  // The exporter of a lease of one; the template (else the roles) of a lease with members.
  const target = leaseTarget(lease);
  if (target) {
    parts.push(target);
  }
  parts.push(status);
  const remaining = isLeaseUsable(status) ? formatRemaining(leaseRemainingSeconds(lease, now)) : "";
  if (remaining) {
    parts.push(remaining);
  }

  const { icon, color } = leaseStatusIcon(status);
  const tooltipLines = [
    lease.name,
    ...(members
      ? memberTooltipLines(lease, direction)
      : [
          ...(exporterSetOf(lease.selector) ? [`Exporter set: ${exporterSetOf(lease.selector)}`] : []),
          `Exporter: ${leaseExporter(lease) || lease.selector || "(selector)"}`,
        ]),
    `Status: ${status}`,
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

  let contextValue = `jumpstarterLease-${statusFlag(status)}`;
  if (vscodeCreated) {
    contextValue += "-vscode";
  }
  if (members) {
    // (last, so that the menus that match a lease by the start of this value take both kinds)
    contextValue += "-members";
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
    expandable: isLeaseUsable(status) || members,
    createdByVscode: vscodeCreated,
  };
}

/**
 * The row of a lease that was ended and is not released yet: what it is a
 * lease of, that it is going, and for how long it has been. It takes no action
 * and opens into nothing: there is nothing to do with a lease on its way out.
 */
export function releasingLeaseRow(row: LeaseRowDescriptor, target: string, releasing: string): LeaseRowDescriptor {
  return {
    ...row,
    description: [target, releasing].filter((part) => part.length > 0).join(" · "),
    tooltip: `${row.tooltip}\nEnding: waiting for the controller to release it.`,
    contextValue: "jumpstarterLeaseReleasing",
    icon: "loading~spin",
    iconColor: "charts.blue",
    expandable: false,
  };
}

const STATUS_RANK: Record<LeaseStatus, number> = {
  "In-Use": 0,
  Degraded: 0,
  Waiting: 1,
  Expired: 2,
  Ended: 3,
  Unknown: 4,
};

/** What the order needs of a request for a lease (see `orderLeaseRows`). */
export interface RequestedLease {
  /** The lease the controller made for it, once it has said so. */
  leaseName?: string;
  startedAt: number;
}

/**
 * The rows of the view, in order: the leases, and the requests for a lease
 * among them where the lease will be once it is held, so that a row does not
 * move when its lease is acquired. A request is ranked as a lease in use and
 * ordered by its lease's name; one whose lease is not made yet comes after
 * the leases in use (a new lease's name is the latest), oldest request first.
 *
 * The same holds on the way out: a lease that was ended and is not released
 * yet (`releasing`) stays where it was, among the leases in use, whatever a
 * listing says of it meanwhile, until its row goes.
 */
export function orderLeaseRows<L extends Lease, R extends RequestedLease>(
  leases: readonly L[],
  requests: readonly R[],
  releasing?: { has(leaseName: string): boolean },
): ({ lease: L } | { request: R })[] {
  const inUse = STATUS_RANK["In-Use"];
  const rows: { rank: number; named: boolean; name: string; at: number; row: { lease: L } | { request: R } }[] = [
    ...leases.map((lease) => ({
      rank: releasing?.has(lease.name) ? inUse : (STATUS_RANK[lease.status] ?? 5),
      named: true,
      name: lease.name,
      at: 0,
      row: { lease },
    })),
    ...requests.map((request) => ({
      rank: inUse,
      named: request.leaseName !== undefined,
      name: request.leaseName ?? "",
      at: request.startedAt,
      row: { request },
    })),
  ];
  return rows
    .sort((a, b) => {
      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }
      if (a.named !== b.named) {
        return a.named ? -1 : 1;
      }
      return a.named ? a.name.localeCompare(b.name) : a.at - b.at;
    })
    .map((entry) => entry.row);
}

/** Active leases first, then by name for a stable order. */
export function sortLeases(leases: readonly Lease[]): Lease[] {
  return [...leases].sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5);
    return rank !== 0 ? rank : a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Driver tree (jmp describe lease --drivers)
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

function makeCommand(node: CliTreeNode, cliPath: string[], role?: string): CommandDescriptor {
  const line = `j ${[...(role ? [role] : []), ...cliPath].join(" ")}`;
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
    params,
    label: line,
    tooltip: lines.join("\n") || line,
    ...(role ? { role } : {}),
  };
}

/**
 * Flatten the runnable leaves of a cli_tree subtree. `basePath` is the path
 * of `node` relative to `j`. A driver whose node is itself a leaf yields a
 * single command.
 */
export function collectCommands(
  node: CliTreeNode,
  basePath: string[],
  role?: string,
): CommandDescriptor[] {
  const subs = node.subcommands ?? {};
  const keys = Object.keys(subs).sort();
  if (keys.length === 0) {
    return basePath.length > 0 ? [makeCommand(node, basePath, role)] : [];
  }
  const out: CommandDescriptor[] = [];
  for (const key of keys) {
    out.push(...collectCommands(subs[key], [...basePath, key], role));
  }
  return out;
}

/**
 * Build driver nodes with their runnable commands. Each driver is matched to
 * its cli_tree subtree via driver_path, falling back to the dotted `path`
 * split into segments; drivers with no matching CLI subtree get no commands.
 *
 * `role` is the role the tree is of, for a lease with members: the drivers
 * and commands are then that role's, and a command runs as `j ROLE ...`.
 */
export function buildDriverNodes(driverTree: LeaseDriverTree, role?: string): DriverNodeDescriptor[] {
  const root = driverTree.cli_tree;
  // The root composite is the session handle itself, not a device: it carries
  // an empty driver_path and no commands of its own, so its children are shown
  // directly under the lease.
  const drivers = (driverTree.drivers ?? []).filter(
    (driver) => (driver.driver_path ?? []).length > 0,
  );
  return drivers.map((driver) => {
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
    const commands = cliNode && cliPath.length > 0 ? collectCommands(cliNode, cliPath, role) : [];
    const driverClass = driver.class ?? "";
    const tooltipLines = [driverClass];
    if (driver.description) {
      tooltipLines.push(driver.description.trim());
    }
    if ((driver.methods ?? []).length > 0) {
      tooltipLines.push(`Methods: ${driver.methods.join(", ")}`);
    }
    return {
      id: driver.path || (driver.driver_path ?? []).join("/"),
      label: tailOfPath(driver.path || driverClass),
      description: tailOfPath(driverClass),
      tooltip: tooltipLines.join("\n"),
      commands,
      driverPath: [...(driver.driver_path ?? [])],
      driverClass,
      ...(role ? { role } : {}),
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

/** "on exporter 'x'", "with roles a, b": what ending a lease gives back, for the confirmation. */
export function describeLeaseHolding(lease: Lease): string {
  if (isMemberLease(lease)) {
    const roles = (lease.members ?? []).map((member) => member.name).join(", ");
    const template = lease.template?.template;
    return template ? ` from template '${template}' (roles ${roles})` : ` with roles ${roles}`;
  }
  return lease.exporter_name ? ` on exporter '${lease.exporter_name}'` : "";
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

// ---------------------------------------------------------------------------
// Running a command with parameters
// ---------------------------------------------------------------------------

/** A value collected for one parameter; undefined means "leave it out". */
export type ParamValue = string | boolean | string[] | undefined;

/** Parameters split into the ones that must be answered and the rest. */
export function promptableParams(command: CommandDescriptor): {
  required: CliParam[];
  optional: CliParam[];
} {
  const params = command.params ?? [];
  return {
    required: params.filter((p) => p.required),
    optional: params.filter((p) => !p.required),
  };
}

/** How an option is spelled on the command line ("--address"). */
export function optionFlag(param: CliParam): string {
  const flags = param.opts ?? [];
  // Prefer the long form; Click lists them in declaration order.
  return flags.find((f) => f.startsWith("--")) ?? flags[0] ?? `--${param.name}`;
}

/** One-line summary of a parameter, for a prompt title. */
export function describeParam(param: CliParam): string {
  const parts = [param.kind === "option" ? optionFlag(param) : param.name];
  if (param.type && param.type !== "text") {
    parts.push(`(${param.type})`);
  }
  if (!param.required && param.default !== null && param.default !== undefined) {
    parts.push(`[default: ${String(param.default)}]`);
  }
  return parts.join(" ");
}

/**
 * Build the `j` argv for a command from collected parameter values.
 *
 * A command of a role of a lease with members starts with the role
 * (`j ROLE DRIVER ...`): in such a lease's shell that is what names the
 * exporter.
 *
 * Options are spelled by their flag and come first, so a positional value
 * that looks like a flag is still read as the argument it is. Arguments keep
 * Click's declaration order. A boolean flag contributes the flag alone when
 * true and nothing when false; a repeatable option contributes one flag per
 * value.
 */
export function buildCommandArgs(
  command: CommandDescriptor,
  values: ReadonlyMap<string, ParamValue>,
): string[] {
  const positional: string[] = [];
  const options: string[] = [];

  for (const param of command.params ?? []) {
    const value = values.get(param.name);
    if (value === undefined || value === "") {
      continue;
    }
    if (param.kind === "option") {
      if (param.is_flag) {
        if (value === true) {
          options.push(optionFlag(param));
        }
        continue;
      }
      for (const single of Array.isArray(value) ? value : [String(value)]) {
        options.push(optionFlag(param), single);
      }
      continue;
    }
    for (const single of Array.isArray(value) ? value : [String(value)]) {
      positional.push(single);
    }
  }

  return [...(command.role ? [command.role] : []), ...command.cliPath, ...options, ...positional];
}
