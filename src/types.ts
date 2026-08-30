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
  enabled: boolean;
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
  type: string;
  help: string;
  required: boolean;
  default: unknown;
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
