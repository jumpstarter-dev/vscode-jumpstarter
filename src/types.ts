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

/** Lease status as reported by `jmp get leases`. */
export type LeaseStatus = "In-Use" | "Waiting" | "Expired" | "Ended" | "Unknown";

export interface Lease {
  name: string;
  namespace: string;
  selector: string;
  /** Full exporter resource reference (may be a path-ish identifier). */
  exporter: string;
  /** Plain exporter name. */
  exporter_name: string;
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
}

export interface GetExportersResponse {
  exporters: Exporter[];
}

export interface GetLeasesResponse {
  leases: Lease[];
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
  } | null;
  status?: {
    beginTime?: string | null;
    endTime?: string | null;
    ended?: boolean;
    exporter?: AdminNameRef | null;
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
  issuer?: string;
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

/** One driver instance inside a lease session (`jmp describe lease --devices`). */
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

/** Recursive `j` CLI tree from `jmp describe lease --devices`. */
export interface CliTreeNode {
  name: string;
  help: string;
  params: CliParam[];
  subcommands: Record<string, CliTreeNode>;
}

export interface LeaseDevices {
  drivers: DeviceDriver[];
  cli_tree: CliTreeNode;
}

export interface LeaseWithDevices {
  lease: Lease;
  devices: LeaseDevices;
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
