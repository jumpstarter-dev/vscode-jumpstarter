/**
 * Pure (VS Code-free) logic for leases with members, lease templates and
 * port forwards: the arguments the CLI is given and what is read from its
 * output.
 *
 * A lease with members (`jmp create lease -t NAME` or `--member`) holds one
 * exporter for each role and has no exporter of its own; a lease template is a
 * set of roles a lab administrator published; a forward connects a port on one
 * role to a port on another. The CLI that has them prints more fields; one
 * that does not prints what it always did. Everything here therefore reads
 * what is there and assumes nothing: a field that is missing, null or of
 * another kind is left out, never an error, and fields this version does not
 * know are kept as they are.
 */

import {
  ExporterPort,
  ForwardEndpoint,
  Lease,
  LeaseConstraint,
  LeaseDriverTree,
  LeaseForward,
  LeaseForwardEndStatus,
  LeaseForwardStatus,
  LeaseMember,
  LeaseMemberStatus,
  LeaseStatus,
  LeaseTemplate,
  LeaseTemplateMember,
} from "../types";
import { CREATED_BY_TAG_KEY, CREATED_BY_TAG_VALUE, JmpError } from "./jmpProtocol";

// ---------------------------------------------------------------------------
// Reading values of unknown shape
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        out[key] = entry;
      }
    }
  }
  return out;
}

function compact<T>(values: (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

function normalizeMember(raw: unknown): LeaseMember | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
    return undefined;
  }
  return {
    name: raw.name,
    selector: optionalText(raw.selector),
    exporter_name: optionalText(raw.exporter_name),
    optional: raw.optional === true,
    allow_disabled: raw.allow_disabled === true,
    excluded: raw.excluded === true,
  };
}

function normalizeMemberStatus(raw: unknown): LeaseMemberStatus | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
    return undefined;
  }
  return {
    name: raw.name,
    state: text(raw.state, "Pending") || "Pending",
    exporter: optionalText(raw.exporter),
    reason: optionalText(raw.reason),
    message: optionalText(raw.message),
  };
}

function normalizeEndpoint(raw: unknown): ForwardEndpoint | undefined {
  if (!isObject(raw) || typeof raw.member_name !== "string" || typeof raw.port_name !== "string") {
    return undefined;
  }
  return { member_name: raw.member_name, port_name: raw.port_name };
}

function normalizeForward(raw: unknown): LeaseForward | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
    return undefined;
  }
  return { name: raw.name, endpoints: compact(list(raw.endpoints).map(normalizeEndpoint)) };
}

function normalizeForwardEnd(raw: unknown): LeaseForwardEndStatus | undefined {
  if (!isObject(raw) || typeof raw.member_name !== "string") {
    return undefined;
  }
  return {
    member_name: raw.member_name,
    state: text(raw.state, "Pending") || "Pending",
    message: optionalText(raw.message),
  };
}

function normalizeForwardStatus(raw: unknown): LeaseForwardStatus | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
    return undefined;
  }
  return {
    name: raw.name,
    state: text(raw.state, "Pending") || "Pending",
    message: optionalText(raw.message),
    ends: compact(list(raw.ends).map(normalizeForwardEnd)),
  };
}

function normalizeConstraint(raw: unknown): LeaseConstraint | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  return {
    member_names: list(raw.member_names).filter((name): name is string => typeof name === "string"),
    same_label: optionalText(raw.same_label),
  };
}

/**
 * One lease as `jmp get leases -o json` printed it, made safe to render.
 *
 * Every field the views read has the kind they expect afterwards, whatever
 * the CLI's version: a lease with members has no exporter (`exporter_name` is
 * null and `exporter` empty), an older CLI has no `status`, and a newer one
 * may have fields nobody here knows, which are kept. Undefined for something
 * that is not a lease at all (no name).
 */
export function normalizeLease(raw: unknown): Lease | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
    return undefined;
  }
  const lease: Lease = {
    ...(raw as unknown as Lease),
    name: raw.name,
    namespace: text(raw.namespace),
    selector: text(raw.selector),
    exporter: text(raw.exporter),
    exporter_name: optionalText(raw.exporter_name),
    client: text(raw.client),
    duration: typeof raw.duration === "number" && Number.isFinite(raw.duration) ? raw.duration : 0,
    effective_begin_time: optionalText(raw.effective_begin_time),
    effective_end_time: optionalText(raw.effective_end_time),
    begin_time: optionalText(raw.begin_time),
    tags: stringMap(raw.tags),
    context: stringMap(raw.context),
    conditions: list(raw.conditions),
    // (a status this version does not know is shown as the CLI named it)
    status: (typeof raw.status === "string" && raw.status.length > 0 ? raw.status : "Unknown") as LeaseStatus,
  };

  const members = compact(list(raw.members).map(normalizeMember));
  if (members.length > 0) {
    lease.members = members;
    lease.member_statuses = compact(list(raw.member_statuses).map(normalizeMemberStatus));
    lease.constraints = compact(list(raw.constraints).map(normalizeConstraint));
    lease.template =
      isObject(raw.template) && typeof raw.template.template === "string" && raw.template.template.length > 0
        ? {
            template: raw.template.template,
            ...(typeof raw.template.generation === "number" ? { generation: raw.template.generation } : {}),
          }
        : null;
  } else {
    delete lease.members;
    delete lease.member_statuses;
    delete lease.constraints;
    delete lease.template;
  }

  const forwards = compact(list(raw.forwards).map(normalizeForward));
  if (forwards.length > 0) {
    lease.forwards = forwards;
    lease.forward_statuses = compact(list(raw.forward_statuses).map(normalizeForwardStatus));
  } else {
    delete lease.forwards;
    delete lease.forward_statuses;
  }
  return lease;
}

/** The leases of a `jmp get leases -o json` answer; anything that is not one is left out. */
export function parseLeases(response: unknown): Lease[] {
  return compact(list(isObject(response) ? response.leases : undefined).map(normalizeLease));
}

// ---------------------------------------------------------------------------
// Lease templates
// ---------------------------------------------------------------------------

function normalizeTemplateMember(raw: unknown): LeaseTemplateMember | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  const member = normalizeMember(raw.member);
  if (!member) {
    return undefined;
  }
  return {
    member,
    available: typeof raw.available === "number" && raw.available > 0 ? Math.floor(raw.available) : 0,
  };
}

/** One lease template, made safe to render; undefined for something that has no name. */
export function normalizeLeaseTemplate(raw: unknown): LeaseTemplate | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
    return undefined;
  }
  return {
    ...(raw as unknown as LeaseTemplate),
    name: raw.name,
    namespace: text(raw.namespace),
    description: text(raw.description),
    docs: list(raw.docs).filter((doc): doc is string => typeof doc === "string" && doc.length > 0),
    image: optionalText(raw.image),
    instructions: optionalText(raw.instructions),
    members: compact(list(raw.members).map(normalizeTemplateMember)),
    constraints: compact(list(raw.constraints).map(normalizeConstraint)),
    default_duration:
      typeof raw.default_duration === "number" && raw.default_duration > 0 ? raw.default_duration : null,
    default_shared_with: list(raw.default_shared_with).filter(
      (name): name is string => typeof name === "string",
    ),
    forwards: compact(list(raw.forwards).map(normalizeForward)),
  };
}

/** The templates of a `jmp get lease-templates -o json` answer. */
export function parseLeaseTemplates(response: unknown): LeaseTemplate[] {
  return compact(
    list(isObject(response) ? response.lease_templates : undefined).map(normalizeLeaseTemplate),
  );
}

/** `jmp get lease-templates -o json --client <client>` */
export function buildGetLeaseTemplatesArgs(client: string): string[] {
  return ["get", "lease-templates", "-o", "json", "--client", client];
}

/** `jmp describe lease-template <name> -o json --client <client>` */
export function buildDescribeLeaseTemplateArgs(client: string, name: string): string[] {
  return ["describe", "lease-template", name, "-o", "json", "--client", client];
}

export interface CreateTemplateLeaseOptions {
  /** The lease template to request. */
  template: string;
  /** Optional roles to leave out (`--without`). */
  without?: readonly string[];
  /** Labels added to the selector of a role (`--member ROLE=SELECTOR`); a request can only narrow a template. */
  memberSelectors?: Readonly<Record<string, string>>;
  /** A duration as the CLI takes it ("30m"); left out, the template's default applies. */
  duration?: string;
  /** Additional tags; the created-by=vscode tag is always added. */
  tags?: Record<string, string>;
}

/** A role name is a DNS label, as the Lease CRD requires. */
const ROLE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function isRoleName(value: string): boolean {
  return value.length <= 63 && ROLE.test(value);
}

/** `jmp create lease --client <client> -t <template> [--without ROLE]... [--duration D] ... -o name` */
export function buildCreateTemplateLeaseArgs(client: string, opts: CreateTemplateLeaseOptions): string[] {
  if (!opts.template) {
    throw new JmpError("usage", "a lease from a template requires the template's name");
  }
  const args = ["create", "lease", "--client", client, "-t", opts.template];
  for (const role of [...new Set(opts.without ?? [])]) {
    if (!isRoleName(role)) {
      throw new JmpError("usage", `'${role}' is not the name of a role`);
    }
    args.push("--without", role);
  }
  for (const [role, selector] of Object.entries(opts.memberSelectors ?? {})) {
    if (!isRoleName(role) || selector.trim().length === 0) {
      throw new JmpError("usage", `'${role}=${selector}' is not a role and a selector`);
    }
    args.push("--member", `${role}=${selector.trim()}`);
  }
  if (opts.duration) {
    args.push("--duration", opts.duration);
  }
  const tags: Record<string, string> = { ...opts.tags, [CREATED_BY_TAG_KEY]: CREATED_BY_TAG_VALUE };
  for (const [key, value] of Object.entries(tags)) {
    args.push("--tag", `${key}=${value}`);
  }
  args.push("-o", "name");
  return args;
}

/**
 * Why a CLI or a controller has no lease templates, when that is what a
 * failure says; undefined for any other failure.
 *
 * A `jmp` from before lease templates has no `lease-templates` command and
 * exits with a usage error; a newer `jmp` against a controller from before
 * them says the controller is too old. Neither is an error of the views: the
 * feature is simply not there.
 */
export function leaseTemplatesUnavailable(error: {
  kind: string;
  message: string;
  stderr?: string;
}): string | undefined {
  const said = `${error.message}\n${error.stderr ?? ""}`;
  if (error.kind === "usage" || /no such command/i.test(said)) {
    return "This jmp has no lease templates (`jmp get lease-templates`): upgrade the Jumpstarter CLI to use them.";
  }
  if (/controller is too old/i.test(said) || /\bUNIMPLEMENTED\b/.test(said)) {
    return "The controller of this client is too old for lease templates.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ports (the directions of a forward's endpoints)
// ---------------------------------------------------------------------------

/** `jmp get exporters --with ports -o json --client <client>` */
export function buildGetExporterPortsArgs(client: string): string[] {
  return ["get", "exporters", "--with", "ports", "-o", "json", "--client", client];
}

function normalizePort(raw: unknown): ExporterPort | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || typeof raw.direction !== "string") {
    return undefined;
  }
  return {
    name: raw.name,
    direction: raw.direction,
    ...(typeof raw.protocol === "string" && raw.protocol ? { protocol: raw.protocol } : {}),
    ...(typeof raw.attachment === "string" ? { attachment: raw.attachment } : {}),
    ...(typeof raw.transport === "string" ? { transport: raw.transport } : {}),
  };
}

/** The ports each exporter declares, by the exporter's name, from `jmp get exporters --with ports -o json`. */
export function parseExporterPorts(response: unknown): Record<string, ExporterPort[]> {
  const ports: Record<string, ExporterPort[]> = {};
  for (const exporter of list(isObject(response) ? response.exporters : undefined)) {
    if (!isObject(exporter) || typeof exporter.name !== "string") {
      continue;
    }
    const declared = compact(list(exporter.ports).map(normalizePort));
    if (declared.length > 0) {
      ports[exporter.name] = declared;
    }
  }
  return ports;
}

// ---------------------------------------------------------------------------
// The drivers of each role
// ---------------------------------------------------------------------------

/** What is known of one role's drivers: its tree, or why it could not be read. */
export type RoleDrivers = { driver_tree: LeaseDriverTree } | { error: string };

const ROLES_BEGIN = "<<<jumpstarter-vscode-roles";
const ROLES_END = "jumpstarter-vscode-roles>>>";

/**
 * A script that prints the driver tree of every role of the lease whose
 * shell it runs in, as `jmp describe lease --drivers` prints the one tree of
 * a lease of one exporter.
 *
 * `jmp describe lease NAME --drivers` refuses a lease with members (it has no
 * one exporter to connect to), so the trees are read where the roles are
 * served: inside `jmp shell --lease NAME`, which gives each bound role a
 * socket and names them in `JMP_LEASE_MEMBERS`. The script uses the same
 * `describe_client` the CLI does, so a role's tree has the shape of a
 * lease's. A role that cannot be read says why and the others are still read.
 * The answer is between two marker lines: whatever else the session prints is
 * not read.
 */
export const ROLE_DRIVERS_SCRIPT = [
  "import json",
  "from contextlib import ExitStack",
  "from anyio.from_thread import start_blocking_portal",
  "from jumpstarter.client.introspect import describe_client",
  "from jumpstarter.utils.env import env_member_async, lease_members_from_env",
  "roles = {}",
  "for role, entry in lease_members_from_env().items():",
  "    if not isinstance(entry, dict) or not entry.get('socket'):",
  "        continue",
  "    try:",
  "        with start_blocking_portal() as portal, ExitStack() as stack:",
  "            with portal.wrap_async_context_manager(env_member_async(role, portal, stack)) as client:",
  "                roles[role] = {'driver_tree': describe_client(client)}",
  "    except Exception as error:",
  "        roles[role] = {'error': f'{type(error).__name__}: {error}'}",
  `print('${ROLES_BEGIN}')`,
  "print(json.dumps({'roles': roles}, default=str))",
  `print('${ROLES_END}')`,
].join("\n");

/** The command to run inside the lease's shell: the interpreter of the session, and the script. */
export function buildRoleDriversCommand(python: string): string[] {
  return [python, "-c", ROLE_DRIVERS_SCRIPT];
}

function isDriverTree(value: unknown): value is LeaseDriverTree {
  return isObject(value) && Array.isArray(value.drivers);
}

/**
 * The driver trees the script printed, by role. Throws JmpError("parse-error")
 * when the session printed no answer at all.
 */
export function parseRoleDrivers(stdout: string): Record<string, RoleDrivers> {
  const begin = stdout.lastIndexOf(ROLES_BEGIN);
  const end = stdout.lastIndexOf(ROLES_END);
  if (begin < 0 || end < begin) {
    throw new JmpError("parse-error", "the lease's session did not answer with the drivers of its roles", {
      stdout,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(begin + ROLES_BEGIN.length, end));
  } catch {
    throw new JmpError("parse-error", "the drivers of the lease's roles could not be read", { stdout });
  }
  const roles: Record<string, RoleDrivers> = {};
  for (const [role, entry] of Object.entries(isObject(parsed) && isObject(parsed.roles) ? parsed.roles : {})) {
    if (!isObject(entry)) {
      continue;
    }
    if (isDriverTree(entry.driver_tree)) {
      roles[role] = { driver_tree: entry.driver_tree };
    } else if (typeof entry.error === "string") {
      roles[role] = { error: entry.error };
    }
  }
  return roles;
}
