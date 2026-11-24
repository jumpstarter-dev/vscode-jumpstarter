/**
 * Pure rendering and selection logic for the Administration view.
 *
 * The admin view reads the cluster through the user's kubeconfig, so it shows
 * every client, exporter, exporter set and lease in a namespace — including
 * the ones the current client cannot see. Everything here is VS Code-free.
 */

import {
  AdminClient,
  AdminExporter,
  AdminExporterSet,
  AdminLease,
  ClientConfigList,
  ExporterStatus,
  LeaseStatus,
} from "../../types";
import {
  categorizeExporter,
  EXPORTER_SET_LABEL_PREFIX,
  iconForCategory,
  IconSpec,
} from "../exporters/model";
import { leaseStatusIcon } from "../leases/model";

/** How a row is drawn: text plus the icon spec the renderer resolves. */
export interface RowSpec {
  label: string;
  description?: string;
  tooltipMarkdown: string;
  icon: IconSpec;
}

/**
 * The namespace to administer.
 *
 * The configured namespace wins; otherwise follow the current client, whose
 * config records the namespace it was issued in — which is the namespace the
 * user is already working in, and rarely Kubernetes' "default".
 */
export function pickAdminNamespace(setting: string, clients?: ClientConfigList | null): string {
  const configured = setting.trim();
  if (configured.length > 0) {
    return configured;
  }
  const current = clients?.items?.find((item) => item.alias === clients.currentConfig);
  const namespace = current?.metadata?.namespace?.trim();
  return namespace && namespace.length > 0 ? namespace : "default";
}

function labelList(labels: Record<string, string> | null | undefined): string[] {
  return Object.entries(labels ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
}

/**
 * A pool member's labels minus the membership ones.
 *
 * The pool row the member sits under already says which set and provisioner it
 * belongs to; repeating that on every member crowds out what differs.
 */
export function memberLabels(
  labels: Record<string, string> | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels ?? {}).filter(([key]) => !key.startsWith(EXPORTER_SET_LABEL_PREFIX)),
  );
}

/** Labels as a one-line description, trimmed to stay readable in a tree. */
export function describeLabels(
  labels: Record<string, string> | null | undefined,
  max = 3,
): string | undefined {
  const all = labelList(labels);
  if (all.length === 0) {
    return undefined;
  }
  return all.length <= max
    ? all.join(" · ")
    : `${all.slice(0, max).join(" · ")} +${all.length - max}`;
}

function labelsMarkdown(labels: Record<string, string> | null | undefined): string[] {
  const all = labelList(labels);
  if (all.length === 0) {
    return [];
  }
  return ["", "**Labels**", ...all.map((entry) => `- \`${entry}\``)];
}

/**
 * Map the status the CRD stores to the one the controller reports over gRPC.
 *
 * They are the same enum spelled two ways — PascalCase in Kubernetes,
 * SCREAMING_SNAKE on the wire — so translating lets an exporter carry the same
 * icon here as in the Exporters view.
 */
export function normalizeAdminExporterStatus(value: string | null | undefined): ExporterStatus | null {
  if (!value) {
    return null;
  }
  const snake = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
  const known: ExporterStatus[] = [
    "UNSPECIFIED",
    "OFFLINE",
    "AVAILABLE",
    "BEFORE_LEASE_HOOK",
    "LEASE_READY",
    "AFTER_LEASE_HOOK",
    "BEFORE_LEASE_HOOK_FAILED",
    "AFTER_LEASE_HOOK_FAILED",
  ];
  return known.includes(snake as ExporterStatus) ? (snake as ExporterStatus) : null;
}

export function clientRow(client: AdminClient): RowSpec {
  const hasCredential = Boolean(client.status?.credential?.name);
  return {
    label: client.metadata.name,
    description: hasCredential ? client.status?.endpoint : "no credential yet",
    tooltipMarkdown: [
      `**${client.metadata.name}**`,
      "",
      `Namespace: \`${client.metadata.namespace}\``,
      client.status?.endpoint ? `Endpoint: \`${client.status.endpoint}\`` : "",
      hasCredential
        ? `Credential: \`${client.status?.credential?.name}\``
        : "The controller has not issued credentials for this client yet.",
      ...labelsMarkdown(client.metadata.labels),
    ]
      .filter((line) => line !== "")
      .join("\n\n"),
    // One icon for what the row is, colour for what state it is in: a client
    // waiting on its credentials is still a client.
    icon: { id: "account", colorId: hasCredential ? "charts.blue" : "charts.yellow" },
  };
}

export function exporterRow(exporter: AdminExporter): RowSpec {
  const devices = exporter.status?.devices?.length ?? 0;
  const registered = Boolean(exporter.status?.credential?.name);
  const status = normalizeAdminExporterStatus(exporter.status?.exporterStatus);
  const description = [
    describeLabels(exporter.metadata.labels),
    devices > 0 ? `${devices} device${devices === 1 ? "" : "s"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    label: exporter.metadata.name,
    description: description.length > 0 ? description : undefined,
    tooltipMarkdown: [
      `**${exporter.metadata.name}**`,
      "",
      `Namespace: \`${exporter.metadata.namespace}\``,
      exporter.status?.statusMessage
        ? `Status: ${exporter.status.statusMessage}`
        : "Status: not reported by the controller.",
      registered
        ? `Credential: \`${exporter.status?.credential?.name}\``
        : "The controller has not issued credentials for this exporter yet.",
      devices > 0
        ? `Reports ${devices} device${devices === 1 ? "" : "s"}, so an exporter is running against it.`
        : "No devices reported: nothing is running `jmp run` against this exporter.",
      ...labelsMarkdown(exporter.metadata.labels),
    ].join("\n\n"),
    // The same status the Exporters view shows, so an exporter looks the same
    // in both places. There is no separate online flag here: one that is
    // offline says so in its status, and one that has never checked in has no
    // status at all, which is unknown rather than offline.
    icon: iconForCategory(categorizeExporter(status, true)),
  };
}

/** A lease the controller still considers live. */
export function isLeaseActive(lease: AdminLease): boolean {
  return lease.status?.ended !== true;
}

/**
 * The status the Leases view would show for this lease.
 *
 * The admin listing has no derived status field, only the facts it is computed
 * from: ended, and whether an exporter is bound yet.
 */
export function adminLeaseStatus(lease: AdminLease): LeaseStatus {
  if (!isLeaseActive(lease)) {
    return "Ended";
  }
  // A lease with members has no exporter of its own: it is held once a role
  // has one, and degraded while a role has lost its.
  const roles = lease.status?.members ?? [];
  if (roles.some((role) => role.state === "Lost")) {
    return "Degraded";
  }
  if (roles.some((role) => role.exporterRef?.name)) {
    return "In-Use";
  }
  return lease.status?.exporter?.name ? "In-Use" : "Waiting";
}

/** The roles of a lease with members, each with its exporter and state; empty for a lease of one exporter. */
export function adminLeaseRoles(lease: AdminLease): { name: string; exporter?: string; state: string }[] {
  const statuses = new Map((lease.status?.members ?? []).map((role) => [role.name, role]));
  return (lease.spec?.members ?? [])
    .filter((member) => typeof member?.name === "string")
    .map((member) => {
      const status = statuses.get(member.name);
      return {
        name: member.name,
        exporter: status?.exporterRef?.name,
        state: status?.state ?? (member.excluded ? "Omitted" : "Pending"),
      };
    });
}

export function leaseRow(lease: AdminLease): RowSpec {
  const active = isLeaseActive(lease);
  const client = lease.spec?.client?.name ?? "unknown client";
  const exporter = lease.status?.exporter?.name;
  const selector = describeLabels(lease.spec?.selector?.matchLabels);
  const { icon, color } = leaseStatusIcon(adminLeaseStatus(lease));
  const roles = adminLeaseRoles(lease);
  const template = lease.spec?.templateRef?.name;
  // A lease with members is named by its template, else by its roles.
  const held = roles.length > 0 ? (template ?? roles.map((role) => role.name).join(", ")) : undefined;
  return {
    label: held ?? exporter ?? selector ?? lease.metadata.name,
    description: [client, lease.spec?.duration, active ? undefined : "ended"]
      .filter(Boolean)
      .join(" · "),
    tooltipMarkdown: [
      `**${lease.metadata.name}**`,
      "",
      `Client: \`${client}\``,
      ...(roles.length > 0
        ? [
            template ? `Template: \`${template}\`` : "",
            ...roles.map(
              (role) => `Role \`${role.name}\`: ${role.exporter ? `\`${role.exporter}\` ` : ""}${role.state}`,
            ),
          ]
        : [exporter ? `Exporter: \`${exporter}\`` : "Not bound to an exporter yet."]),
      selector ? `Selector: \`${selector}\`` : "",
      lease.spec?.duration ? `Duration: ${lease.spec.duration}` : "",
      lease.status?.beginTime ? `Began: ${lease.status.beginTime}` : "",
      lease.status?.endTime ? `Ended: ${lease.status.endTime}` : "",
    ]
      .filter((line) => line !== "")
      .join("\n\n"),
    // Drawn the way the Leases view draws the same status.
    icon: { id: icon, colorId: color },
  };
}

export function exporterSetRow(set: AdminExporterSet): RowSpec {
  const status = set.status ?? {};
  const available = status.availableReplicas ?? 0;
  const replicas = status.replicas ?? set.exporters?.length ?? 0;
  const spec = set.spec ?? {};
  return {
    label: set.metadata.name,
    description: `${available}/${replicas} available`,
    tooltipMarkdown: [
      `**${set.metadata.name}**`,
      "",
      spec.virtualTargetClassName ? `Class: \`${spec.virtualTargetClassName}\`` : "",
      spec.provisioner ? `Provisioner: \`${spec.provisioner}\`` : "",
      spec.bindingMode ? `Binding: ${spec.bindingMode}` : "",
      `Replicas: ${spec.minReplicas ?? 0}–${spec.maxReplicas ?? "∞"}, ` +
        `${spec.minAvailableReplicas ?? 0} kept warm`,
      `Ready: ${status.readyReplicas ?? 0}, leased: ${status.leasedReplicas ?? 0}`,
      ...labelsMarkdown(spec.selector),
    ]
      .filter((line) => line !== "")
      .join("\n\n"),
    icon: { id: "layers", colorId: "charts.purple" },
  };
}

export function sortByName<T extends { metadata: { name: string } }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

/**
 * Leases newest first: an admin looking at leases wants what is happening now,
 * and a namespace accumulates ended leases indefinitely.
 */
export function sortLeases(leases: readonly AdminLease[]): AdminLease[] {
  return [...leases].sort((a, b) => {
    if (isLeaseActive(a) !== isLeaseActive(b)) {
      return isLeaseActive(a) ? -1 : 1;
    }
    const at = Date.parse(a.status?.beginTime ?? a.metadata.creationTimestamp ?? "");
    const bt = Date.parse(b.status?.beginTime ?? b.metadata.creationTimestamp ?? "");
    if (Number.isNaN(at) || Number.isNaN(bt)) {
      return a.metadata.name.localeCompare(b.metadata.name);
    }
    return bt - at;
  });
}

/** Client configs already on this machine, by the name they were issued as. */
export function importedClientNames(clients?: ClientConfigList | null): Set<string> {
  return new Set((clients?.items ?? []).map((item) => item.metadata?.name).filter(Boolean));
}
