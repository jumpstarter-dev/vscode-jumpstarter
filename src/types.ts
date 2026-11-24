/**
 * TypeScript interfaces for the JSON shapes emitted by `jmp ... -o json`.
 *
 * Field names intentionally mirror the CLI's snake_case output so objects can
 * be used directly after JSON.parse without mapping.
 */

/** Exporter status as reported by `jmp get exporters --with status`. */
export type ExporterStatus =
  | "AVAILABLE"
  | "OFFLINE"
  | "LEASE_READY"
  | "BEFORE_LEASE_HOOK"
  | "AFTER_LEASE_HOOK"
  | "BEFORE_LEASE_HOOK_FAILED"
  | "AFTER_LEASE_HOOK_FAILED"
  | "UNSPECIFIED";

/**
 * Lease status as reported by `jmp get leases`. `Degraded` is a lease with
 * members of which one lost its exporter: the other roles stay usable.
 */
export type LeaseStatus = "In-Use" | "Degraded" | "Waiting" | "Expired" | "Ended" | "Unknown";

/** Whether a lease holds exporters a session can be opened on (a degraded lease still serves its bound roles). */
export function isLeaseUsable(status: LeaseStatus): boolean {
  return status === "In-Use" || status === "Degraded";
}

/** One role of a lease with members, or of a lease template. */
export interface LeaseMember {
  name: string;
  selector?: string | null;
  exporter_name?: string | null;
  optional?: boolean;
  allow_disabled?: boolean;
  excluded?: boolean;
}

/** What the controller says of one role: `Pending`, `Bound`, `Omitted` or `Lost`. */
export interface LeaseMemberStatus {
  name: string;
  state: string;
  exporter?: string | null;
  reason?: string | null;
  message?: string | null;
}

export interface ForwardEndpoint {
  member_name: string;
  port_name: string;
}

/** A forward: it connects ports on different roles of a lease. */
export interface LeaseForward {
  name: string;
  endpoints: ForwardEndpoint[];
}

/** The state of one end of a forward: `Pending`, `Ready`, `Connected` or `Failed`. */
export interface LeaseForwardEndStatus {
  member_name: string;
  state: string;
  message?: string | null;
}

/** The state of a forward: `Pending`, `Disabled`, `Listening`, `Connected` or `Failed`. */
export interface LeaseForwardStatus {
  name: string;
  state: string;
  message?: string | null;
  ends?: LeaseForwardEndStatus[];
}

export interface LeaseConstraint {
  member_names: string[];
  same_label?: string | null;
}

/** The lease template a lease was made from. */
export interface LeaseTemplateUse {
  template: string;
  generation?: number;
}

export interface Lease {
  name: string;
  namespace: string;
  selector: string;
  /** Full exporter resource reference (may be a path-ish identifier). Empty for a lease with members. */
  exporter: string;
  /** Plain exporter name. Null for a lease with members: each role has its own (member_statuses). */
  exporter_name: string | null;
  client: string;
  /** Lease duration in seconds (float). */
  duration: number;
  /** ISO timestamp when the lease actually began, or null if not started. */
  effective_begin_time: string | null;
  effective_end_time: string | null;
  begin_time: string | null;
  tags: Record<string, string>;
  context: Record<string, string>;
  conditions: unknown[];
  status: LeaseStatus;
  /**
   * Set for a lease with members only (`jmp create lease -t` / `--member`);
   * a lease of one exporter has none of these fields.
   */
  members?: LeaseMember[];
  constraints?: LeaseConstraint[];
  template?: LeaseTemplateUse | null;
  member_statuses?: LeaseMemberStatus[];
  /** Set for a lease with forwards only. */
  forwards?: LeaseForward[];
  forward_statuses?: LeaseForwardStatus[];
}

/** A port a driver of an exporter declares (`jmp get exporters --with ports`). */
export interface ExporterPort {
  name: string;
  /** `provides`, `requires` or `connects`. */
  direction: string;
  protocol?: string | null;
  attachment?: string;
  transport?: string;
}

/** One role of a lease template, with how many exporters the client could lease for it now. */
export interface LeaseTemplateMember {
  member: LeaseMember;
  available: number;
}

/** A lease template, as `jmp get lease-templates -o json` lists it. */
export interface LeaseTemplate {
  namespace: string;
  name: string;
  description: string;
  docs: string[];
  image?: string | null;
  instructions?: string | null;
  members: LeaseTemplateMember[];
  constraints: LeaseConstraint[];
  /** Seconds (float), or null when a request must name a duration. */
  default_duration: number | null;
  default_shared_with: string[];
  generation?: number;
  forwards: LeaseForward[];
}

export interface Exporter {
  namespace: string;
  name: string;
  labels: Record<string, string>;
  deprecated_labels: Record<string, string>;
  online: boolean;
  /** Null when the controller does not report exporter status (older builds). */
  status: ExporterStatus | null;
  /**
   * Only present with `--allow-disabled`; absent means the exporter is
   * enabled, since the CLI omits disabled exporters without that flag.
   */
  enabled?: boolean;
  /** The active lease on this exporter, or null when unleased. */
  lease: Lease | null;
  /** Only with `--with ports`, and only for an exporter that declares ports. */
  ports?: ExporterPort[];
}

export interface GetExportersResponse {
  exporters: Exporter[];
}

export interface ClientConfigMetadata {
  name: string;
  namespace: string;
}

export interface ClientConfigItem {
  alias: string;
  /** Absolute path of clients/<alias>.yaml on disk. */
  path: string;
  endpoint: string;
  metadata: ClientConfigMetadata;
  /** TLS options; shape not further specified. */
  tls?: unknown;
  /** Driver allow settings; shape not further specified. Tokens inside are REDACTED. */
  drivers?: unknown;
}

export interface ClientConfigList {
  /** Alias of the current default client, or null when none selected. */
  currentConfig: string | null;
  items: ClientConfigItem[];
}

/** One driver's config keys as JSON Schema, from `jmp driver schema`. */
export interface DriverSchema {
  name: string;
  type: string;
  package?: string | null;
  version?: string | null;
  description?: string | null;
  /** Client class the driver is consumed through; what drivers.allow matches. */
  client?: string | null;
  properties: Record<string, unknown>;
  /** Definitions the properties reference ("#/$defs/..."). */
  defs?: Record<string, unknown>;
  required: string[];
  /** Set when the driver could not be loaded or modelled; keys may still be present. */
  error?: string | null;
}

export interface DriverSchemaResponse {
  drivers: DriverSchema[];
}

/**
 * One locally configured exporter, reduced to what the extension may hold.
 *
 * `jmp config exporter list -o json` also returns the exporter's token; it is
 * dropped at the service boundary and never stored or logged.
 */
export interface ExporterConfigRef {
  alias: string;
  /** Absolute path of exporters/<alias>.yaml. */
  path: string;
  /** metadata.name, which is the name the controller knows it by. */
  name: string;
}

// ---------------------------------------------------------------------------
// Cluster administration (`jmp admin get ... -o json`)
//
// These are Kubernetes objects, so they carry apiVersion/kind/metadata rather
// than the flattened shapes the controller reports to a client.
// ---------------------------------------------------------------------------

export interface AdminObjectMeta {
  name: string;
  namespace: string;
  labels?: Record<string, string> | null;
  creationTimestamp?: string | null;
  uid?: string | null;
}

/** A reference to another object by name (a credential Secret, a client...). */
export interface AdminNameRef {
  name: string;
}

export interface AdminClient {
  metadata: AdminObjectMeta;
  status?: {
    endpoint?: string;
    credential?: AdminNameRef | null;
  } | null;
}

export interface AdminExporterDevice {
  uuid: string;
  labels: Record<string, string>;
}

export interface AdminExporter {
  metadata: AdminObjectMeta;
  status?: {
    endpoint?: string;
    credential?: AdminNameRef | null;
    devices?: AdminExporterDevice[] | null;
    /**
     * The operational status the exporter last reported, PascalCase as the
     * CRD stores it ("Available", "LeaseReady", ...) rather than the
     * SCREAMING_SNAKE the controller sends clients over gRPC.
     */
    exporterStatus?: string | null;
    statusMessage?: string | null;
  } | null;
}

export interface AdminLease {
  metadata: AdminObjectMeta;
  spec?: {
    client?: AdminNameRef | null;
    duration?: string;
    release?: boolean;
    selector?: { matchLabels?: Record<string, string> | null } | null;
    /** A lease with members: its roles, and the template it was made from. */
    members?: { name: string; optional?: boolean | null; excluded?: boolean | null }[] | null;
    templateRef?: { name: string; generation?: number } | null;
  } | null;
  status?: {
    beginTime?: string | null;
    endTime?: string | null;
    ended?: boolean;
    exporter?: AdminNameRef | null;
    /** A lease with members: the state and the exporter of each role. */
    members?: { name: string; state?: string; reason?: string | null; exporterRef?: AdminNameRef | null }[] | null;
  } | null;
}

/** One member exporter of a set, as `jmp admin get exporterset` reports it. */
export interface AdminExporterSetMember {
  name: string;
  labels?: Record<string, string> | null;
  online?: boolean | null;
  leased?: boolean | null;
}

export interface AdminExporterSet {
  metadata: AdminObjectMeta;
  spec?: {
    virtualTargetClassName?: string | null;
    provisioner?: string | null;
    bindingMode?: string | null;
    minReplicas?: number | null;
    maxReplicas?: number | null;
    minAvailableReplicas?: number | null;
    scaleDownCooldown?: string | null;
    recycleStrategy?: string | null;
    selector?: Record<string, string> | null;
    templateLabels?: Record<string, string> | null;
  } | null;
  status?: Record<string, number> | null;
  exporters?: AdminExporterSetMember[] | null;
}

export interface AdminList<T> {
  items?: T[];
}

/** One resource as `jmp admin apply -o json` reports it. */
export interface AppliedResource {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
  action: "created" | "configured" | "unchanged";
}

export type AuthStatusValue =
  | "valid"
  | "expiring-soon"
  | "expired"
  | "no-token"
  | "invalid-token"
  | "no-expiry";

export interface AuthStatus {
  status: AuthStatusValue;
  /** ISO timestamp, or null when there is no expiry / no token. */
  expiresAt: string | null;
  remainingSeconds: number | null;
  subject?: string;
  /**
   * The token's `iss` claim. Present for API keys too — the controller mints
   * them as JWTs — so this does NOT identify an OIDC client.
   */
  issuer?: string;
  /** ISO timestamp of the `auth_time` claim; only interactive logins have one. */
  authTime?: string | null;
  /** True when a refresh token is stored, which only an OIDC login produces. */
  refreshTokenStored?: boolean;
}

export interface DriverInfo {
  name: string;
  /** Fully qualified Python class, e.g. "jumpstarter_driver_power.driver.MockPower". */
  type: string;
  package: string;
  version: string;
}

export interface DriverListResponse {
  drivers: DriverInfo[];
}

export interface JmpVersion {
  gitVersion: string;
  pythonVersion: string;
}

/** One driver instance inside a lease session (`jmp describe lease --drivers`). */
export interface DeviceDriver {
  path: string;
  driver_path: string[];
  class: string;
  description: string;
  methods: string[];
}

export interface CliParam {
  name: string;
  /** "argument" (positional) or "option" (spelled by a flag). */
  kind?: "argument" | "option";
  /** Click's type name, e.g. "text", "integer", "path", "choice". */
  type: string;
  help: string | null;
  required: boolean;
  default: unknown;
  /** Flags that spell an option ("--address"), or the name for an argument. */
  opts?: string[];
  /** A boolean flag takes no value. */
  is_flag?: boolean;
  /** The option may be repeated. */
  multiple?: boolean;
  nargs?: number;
  /** Accepted values when the type is a choice. */
  choices?: string[];
}

/** Recursive `j` CLI tree from `jmp describe lease --drivers`. */
export interface CliTreeNode {
  name: string;
  help: string;
  params: CliParam[];
  subcommands: Record<string, CliTreeNode>;
}

export interface LeaseDriverTree {
  drivers: DeviceDriver[];
  cli_tree: CliTreeNode;
}

export interface LeaseWithDrivers {
  lease: Lease;
  driver_tree: LeaseDriverTree;
}

/**
 * Remaining seconds on a lease, computed as
 * effective_begin_time + duration - now. Returns null when the lease has no
 * effective_begin_time (not started yet) or an unparseable timestamp.
 * May return a negative number for an over-run lease.
 */
export function leaseRemainingSeconds(lease: Lease, now: Date = new Date()): number | null {
  if (!lease.effective_begin_time) {
    return null;
  }
  const begin = Date.parse(lease.effective_begin_time);
  if (Number.isNaN(begin)) {
    return null;
  }
  return (begin + lease.duration * 1000 - now.getTime()) / 1000;
}
