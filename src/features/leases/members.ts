/**
 * Pure logic for a lease with members in the Leases view: its roles, its
 * forwards and what it says of itself. No vscode imports; unit-tested under
 * plain node (src/test/unit/leaseMembers.test.ts).
 *
 * A lease with members holds one exporter for each **role** and has no
 * exporter of its own. The view shows it as the lease, with a row for each
 * role (its exporter and state) and a row for each forward between them.
 */

import { ExporterPort, Lease, LeaseForward, LeaseMemberStatus, isLeaseUsable } from "../../types";

/** True for a lease that has roles instead of one exporter. */
export function isMemberLease(lease: Pick<Lease, "members">): boolean {
  return (lease.members ?? []).length > 0;
}

/** The name of the template a lease was made from, when it was made from one. */
export function templateName(lease: Pick<Lease, "template">): string | undefined {
  return lease.template?.template || undefined;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** What a role's state is called; anything else the controller says is shown as it is. */
export type RoleState = "Pending" | "Bound" | "Omitted" | "Lost" | (string & {});

export interface RoleDescriptor {
  /** The role's name: what `j ROLE ...` takes. */
  name: string;
  optional: boolean;
  state: RoleState;
  /** The exporter bound to the role (or the one a lost role had). */
  exporter: string | null;
  /** Why the role is Omitted or Lost, as the controller named it. */
  reason: string | null;
  message: string | null;
  /** How the role finds its exporter: a selector, or `exporter NAME`. */
  selection: string;
  /** Whether the role has an exporter to open drivers on. */
  bound: boolean;
}

/** The roles of a lease in the lease's order, each with its state. Empty for a lease of one exporter. */
export function leaseRoles(lease: Pick<Lease, "members" | "member_statuses">): RoleDescriptor[] {
  const statuses = new Map<string, LeaseMemberStatus>();
  for (const status of lease.member_statuses ?? []) {
    statuses.set(status.name, status);
  }
  return (lease.members ?? []).map((member) => {
    const status = statuses.get(member.name);
    // (a role the controller has not reported yet is Pending, unless the request left it out)
    const state: RoleState = status?.state || (member.excluded ? "Omitted" : "Pending");
    const exporter = status?.exporter || null;
    return {
      name: member.name,
      optional: member.optional === true,
      state,
      exporter,
      reason: status?.reason || null,
      message: status?.message || null,
      selection: member.exporter_name ? `exporter ${member.exporter_name}` : (member.selector ?? ""),
      bound: state === "Bound" && exporter !== null,
    };
  });
}

/**
 * Whether a lease is degraded: a role lost its exporter while the lease runs.
 * The CLI says so as the lease's status; a lost role says it too, for a CLI
 * that derives the status another way. A lease that is over is not degraded.
 */
export function isDegraded(lease: Lease): boolean {
  if (lease.status === "Ended" || lease.status === "Expired") {
    return false;
  }
  return lease.status === "Degraded" || leaseRoles(lease).some((role) => role.state === "Lost");
}

/**
 * Whether a lease can be worked on now: it is in use, or degraded (its bound
 * roles are still served, which is what entering a degraded lease is for).
 */
export function isWorkable(lease: Lease): boolean {
  return isLeaseUsable(lease.status) || isDegraded(lease);
}

/** Why a degraded lease is degraded, in one line. */
export function describeDegraded(lease: Lease): string {
  const lost = leaseRoles(lease).filter((role) => role.state === "Lost");
  if (lost.length === 0) {
    return "Degraded: a role of the lease has no exporter";
  }
  const names = lost.map((role) => (role.reason ? `${role.name} (${role.reason})` : role.name));
  return `Degraded: ${names.join(", ")} lost ${lost.length === 1 ? "its exporter" : "their exporters"}`;
}

/**
 * What a lease is a lease *of*, wherever one line has to say it: the exporter
 * of a lease of one, the template of a lease with members, else its roles.
 * Empty when the lease has neither (not bound yet, by a selector).
 */
export function leaseTarget(lease: Lease): string {
  if (!isMemberLease(lease)) {
    return lease.exporter_name || "";
  }
  return templateName(lease) ?? leaseRoles(lease).map((role) => role.name).join(", ");
}

/** `Bound`, `Lost: Offline`, `Omitted: Excluded`: a role's state, with the reason it is not there. */
export function describeRoleState(role: RoleDescriptor): string {
  if ((role.state === "Lost" || role.state === "Omitted") && role.reason) {
    return `${role.state}: ${role.reason}`;
  }
  return role.state;
}

export interface MemberRowDescriptor {
  id: string;
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  icon: string;
  iconColor: string | undefined;
  expandable: boolean;
}

function stateIcon(state: string): { icon: string; color: string | undefined } {
  switch (state) {
    case "Bound":
      return { icon: "server-environment", color: "charts.green" };
    case "Lost":
      return { icon: "error", color: "charts.red" };
    case "Omitted":
      return { icon: "circle-slash", color: "disabledForeground" };
    case "Pending":
      return { icon: "clock", color: "charts.blue" };
    default:
      return { icon: "question", color: undefined };
  }
}

/**
 * The row of one role under its lease.
 *
 * `usable` is whether the lease can be worked on now (In-Use or Degraded):
 * only then does a bound role open into its drivers.
 */
export function buildRoleRow(lease: Lease, role: RoleDescriptor, usable: boolean): MemberRowDescriptor {
  const parts: string[] = [];
  if (role.exporter && role.state !== "Lost") {
    parts.push(role.exporter);
  }
  parts.push(describeRoleState(role));
  if (role.exporter && role.state === "Lost") {
    parts.push(`was ${role.exporter}`);
  }
  if (role.optional) {
    parts.push("optional");
  }

  const tooltip = [
    `Role: ${role.name}${role.optional ? " (optional)" : ""}`,
    `State: ${describeRoleState(role)}`,
  ];
  if (role.exporter) {
    tooltip.push(`Exporter: ${role.exporter}`);
  }
  if (role.selection) {
    tooltip.push(`Selects: ${role.selection}`);
  }
  if (role.message) {
    tooltip.push(role.message);
  }
  if (role.bound) {
    tooltip.push(`Commands run as: j ${role.name} DRIVER …`);
  }

  const { icon, color } = stateIcon(role.state);
  const flag = ["Bound", "Lost", "Omitted", "Pending"].includes(role.state)
    ? role.state.toLowerCase()
    : "unknown";
  return {
    id: `jumpstarter.role/${lease.namespace}/${lease.name}/${role.name}`,
    label: role.name,
    description: parts.join(" · "),
    tooltip: tooltip.join("\n"),
    contextValue: `jumpstarterRole-${flag}`,
    icon,
    iconColor: color,
    expandable: usable && role.bound,
  };
}

// ---------------------------------------------------------------------------
// Forwards
// ---------------------------------------------------------------------------

/** The direction of a role's port (`provides`, `requires`, `connects`), when it is known. */
export type DirectionLookup = (role: string, port: string) => string | undefined;

/**
 * The directions of the ports of a lease's roles, from what each role's
 * exporter declares (`jmp get exporters --with ports`). A port whose exporter
 * is not known, or declares nothing, has no direction: its forward is then
 * shown without an arrow.
 */
export function portDirections(
  lease: Pick<Lease, "members" | "member_statuses">,
  portsByExporter: Readonly<Record<string, readonly ExporterPort[]>>,
): DirectionLookup {
  const directions = new Map<string, string>();
  for (const role of leaseRoles(lease)) {
    if (!role.exporter) {
      continue;
    }
    for (const port of portsByExporter[role.exporter] ?? []) {
      directions.set(`${role.name}\0${port.name}`, port.direction);
    }
  }
  return (role, port) => directions.get(`${role}\0${port}`);
}

/**
 * The endpoints of a forward, as the CLI writes them: an arrow from the
 * `provides` port to each `requires` port, a double arrow between the two
 * ends of a path (`connects`), and the endpoints in the lease's order when
 * the directions are not known.
 */
export function describeForward(forward: LeaseForward, direction: DirectionLookup = () => undefined): string {
  const endpoints = forward.endpoints ?? [];
  const names = endpoints.map((endpoint) => `${endpoint.member_name}.${endpoint.port_name}`);
  const known = endpoints.map((endpoint) => direction(endpoint.member_name, endpoint.port_name));
  if (endpoints.length === 2 && known[0] === "connects" && known[1] === "connects") {
    return `${names[0]} ↔ ${names[1]}`;
  }
  const provides = known.filter((d) => d === "provides").length;
  const requires = known.filter((d) => d === "requires").length;
  if (endpoints.length > 1 && provides === 1 && requires === endpoints.length - 1) {
    const source = names[known.indexOf("provides")];
    const targets = names.filter((_, index) => known[index] === "requires");
    return `${source} → ${targets.join(", ")}`;
  }
  return names.join(", ");
}

export interface ForwardDescriptor {
  name: string;
  /** `headunit.rootcanal → phone.controller` */
  endpoints: string;
  /** `Pending`, `Listening`, `Connected`, `Disabled` or `Failed`; Pending until the controller reports it. */
  state: string;
  message: string | null;
  /** `member: State (message)` for each end the controller reports. */
  ends: string[];
}

/** The forwards of a lease, each with its state. Empty for a lease without forwards. */
export function leaseForwards(
  lease: Pick<Lease, "forwards" | "forward_statuses">,
  direction: DirectionLookup = () => undefined,
): ForwardDescriptor[] {
  const statuses = new Map((lease.forward_statuses ?? []).map((status) => [status.name, status]));
  return (lease.forwards ?? []).map((forward) => {
    const status = statuses.get(forward.name);
    return {
      name: forward.name,
      endpoints: describeForward(forward, direction),
      state: status?.state || "Pending",
      message: status?.message || null,
      ends: (status?.ends ?? []).map((end) =>
        end.message ? `${end.member_name}: ${end.state} (${end.message})` : `${end.member_name}: ${end.state}`,
      ),
    };
  });
}

function forwardIcon(state: string): { icon: string; color: string | undefined } {
  switch (state) {
    case "Connected":
      return { icon: "plug", color: "charts.green" };
    case "Listening":
      return { icon: "plug", color: "charts.blue" };
    case "Pending":
      return { icon: "clock", color: "charts.blue" };
    case "Disabled":
      return { icon: "circle-slash", color: "disabledForeground" };
    case "Failed":
      return { icon: "error", color: "charts.red" };
    default:
      return { icon: "question", color: undefined };
  }
}

/** The row of one forward under its lease. The state of each end is in the tooltip. */
export function buildForwardRow(lease: Lease, forward: ForwardDescriptor): MemberRowDescriptor {
  const parts = [forward.endpoints, forward.state].filter((part) => part.length > 0);
  // The message is the cause of a forward that does not operate: worth a place on the row itself.
  if (forward.message && (forward.state === "Failed" || forward.state === "Disabled")) {
    parts[parts.length - 1] = `${forward.state}: ${forward.message}`;
  }
  const tooltip = [`Forward: ${forward.name}`, `Connects: ${forward.endpoints || "(no endpoints)"}`, `State: ${forward.state}`];
  if (forward.message) {
    tooltip.push(`Message: ${forward.message}`);
  }
  if (forward.ends.length > 0) {
    tooltip.push("Ends:", ...forward.ends.map((end) => `  ${end}`));
  }
  const { icon, color } = forwardIcon(forward.state);
  return {
    id: `jumpstarter.forward/${lease.namespace}/${lease.name}/${forward.name}`,
    label: forward.name,
    description: parts.join(" · "),
    tooltip: tooltip.join("\n"),
    contextValue: "jumpstarterForward",
    icon,
    iconColor: color,
    expandable: false,
  };
}

/** Lines for a lease's tooltip: its template, its roles and its forwards. Empty for a lease of one exporter. */
export function memberTooltipLines(lease: Lease, direction: DirectionLookup = () => undefined): string[] {
  if (!isMemberLease(lease)) {
    return [];
  }
  const lines: string[] = [];
  const template = templateName(lease);
  if (template) {
    lines.push(`Template: ${template}`);
  }
  lines.push("Roles:");
  for (const role of leaseRoles(lease)) {
    const exporter = role.exporter ? ` ${role.exporter}` : "";
    lines.push(`  ${role.name}${role.optional ? "*" : ""}:${exporter} [${describeRoleState(role)}]`);
  }
  const forwards = leaseForwards(lease, direction);
  if (forwards.length > 0) {
    lines.push("Forwards:");
    for (const forward of forwards) {
      lines.push(`  ${forward.name}: ${forward.endpoints} [${forward.state}]`);
    }
  }
  return lines;
}
