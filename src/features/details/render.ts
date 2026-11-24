/**
 * Pure rendering for the Jumpstarter details pane.
 *
 * Everything here is host-free so it can be unit-tested: the webview only
 * receives the HTML these functions build. Values come from objects the tree
 * views already fetched, so opening the pane costs no extra CLI calls.
 */

import { Exporter, Lease, LeaseTemplate } from "../../types";
import { ClientRow } from "../clients/logic";
import {
  describeForward,
  describeRoleState,
  isMemberLease,
  leaseForwards,
  leaseRoles,
  templateName,
} from "../leases/members";
import * as templates from "../leaseTemplates/model";

export type DetailsSelection =
  | { kind: "client"; client: ClientRow }
  | { kind: "exporter"; exporter: Exporter }
  | { kind: "lease"; lease: Lease }
  | { kind: "leaseTemplate"; template: LeaseTemplate };

export interface DetailRow {
  label: string;
  value: string;
  /** Render in a monospace cell (identifiers, endpoints, selectors). */
  mono?: boolean;
}

export interface DetailSection {
  title: string;
  rows: DetailRow[];
  /**
   * Text shown as it was written, line breaks and all (a template's
   * instructions). Always escaped: it is plain text, never markup.
   */
  text?: string;
}

const EMPTY = "—";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function text(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? EMPTY : value;
}

function yesNo(value: boolean | undefined, fallback = EMPTY): string {
  return value === undefined ? fallback : value ? "yes" : "no";
}

function formatMap(map: Record<string, string> | undefined): string {
  const entries = Object.entries(map ?? {});
  if (entries.length === 0) {
    return EMPTY;
  }
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) {
    return EMPTY;
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return EMPTY;
  }
  const total = Math.max(0, Math.round(seconds));
  const parts: string[] = [];
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days) {
    parts.push(`${days}d`);
  }
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes) {
    parts.push(`${minutes}m`);
  }
  if (!parts.length) {
    parts.push(`${secs}s`);
  }
  return parts.join("");
}

export function buildClientSections(client: ClientRow): DetailSection[] {
  return [
    {
      title: "Client",
      rows: [
        { label: "Alias", value: client.alias, mono: true },
        { label: "Current", value: yesNo(client.isCurrent) },
        { label: "Name", value: text(client.name) },
        { label: "Namespace", value: text(client.namespace) },
        { label: "Endpoint", value: text(client.endpoint), mono: true },
        { label: "Config", value: text(client.path), mono: true },
      ],
    },
    {
      title: "Authentication",
      rows: [
        { label: "Status", value: client.authError ?? text(client.auth?.status) },
        { label: "Expires", value: formatTimestamp(client.auth?.expiresAt) },
        { label: "Subject", value: text(client.auth?.subject), mono: true },
        { label: "Issuer", value: text(client.auth?.issuer), mono: true },
        { label: "Refresh token", value: yesNo(client.auth?.refreshTokenStored) },
      ],
    },
  ];
}

export function buildExporterSections(exporter: Exporter): DetailSection[] {
  const sections: DetailSection[] = [
    {
      title: "Exporter",
      rows: [
        { label: "Name", value: exporter.name, mono: true },
        { label: "Namespace", value: text(exporter.namespace) },
        { label: "Status", value: text(exporter.status) },
        { label: "Online", value: yesNo(exporter.online) },
        { label: "Enabled", value: yesNo(exporter.enabled, "yes") },
      ],
    },
    {
      title: "Labels",
      rows: [
        { label: "Labels", value: formatMap(exporter.labels), mono: true },
        ...(Object.keys(exporter.deprecated_labels ?? {}).length
          ? [
              {
                label: "Deprecated",
                value: formatMap(exporter.deprecated_labels),
                mono: true,
              },
            ]
          : []),
      ],
    },
  ];
  if (exporter.lease) {
    sections.push({
      title: "Current lease",
      rows: [
        { label: "Lease", value: exporter.lease.name, mono: true },
        { label: "Held by", value: text(exporter.lease.client) },
        { label: "Status", value: text(exporter.lease.status) },
      ],
    });
  }
  return sections;
}

export function buildLeaseSections(lease: Lease): DetailSection[] {
  const members = isMemberLease(lease);
  const forwards = leaseForwards(lease);
  return [
    {
      title: "Lease",
      rows: [
        { label: "Name", value: lease.name, mono: true },
        { label: "Namespace", value: text(lease.namespace) },
        { label: "Status", value: text(lease.status) },
        { label: "Client", value: text(lease.client) },
        // A lease with members has no exporter of its own: each role has one (below).
        ...(members
          ? [{ label: "Template", value: text(templateName(lease)), mono: true }]
          : [
              { label: "Exporter", value: text(lease.exporter_name ?? lease.exporter), mono: true },
              { label: "Selector", value: text(lease.selector), mono: true },
            ]),
      ],
    },
    ...(members
      ? [
          {
            title: "Roles",
            rows: leaseRoles(lease).map((role) => ({
              label: role.optional ? `${role.name}*` : role.name,
              value: [role.exporter, describeRoleState(role), role.message].filter(Boolean).join(" · "),
              mono: true,
            })),
          },
        ]
      : []),
    ...(forwards.length > 0
      ? [
          {
            title: "Forwards",
            rows: forwards.map((forward) => ({
              label: forward.name,
              value: [forward.endpoints, forward.state, forward.message, ...forward.ends]
                .filter(Boolean)
                .join(" · "),
              mono: true,
            })),
          },
        ]
      : []),
    {
      title: "Timing",
      rows: [
        { label: "Duration", value: formatSeconds(lease.duration) },
        { label: "Started", value: formatTimestamp(lease.effective_begin_time) },
        { label: "Ended", value: formatTimestamp(lease.effective_end_time) },
      ],
    },
    {
      title: "Metadata",
      rows: [
        { label: "Tags", value: formatMap(lease.tags), mono: true },
        { label: "Context", value: formatMap(lease.context), mono: true },
      ],
    },
  ];
}

export function buildLeaseTemplateSections(template: LeaseTemplate): DetailSection[] {
  const sections: DetailSection[] = [
    {
      title: "Lease template",
      rows: [
        { label: "Name", value: template.name, mono: true },
        { label: "Namespace", value: text(template.namespace) },
        { label: "Description", value: text(template.description) },
        { label: "Available", value: `${templates.availableSummary(template)} roles` },
        { label: "Default duration", value: text(templates.formatDuration(template.default_duration)) },
        { label: "Shared with", value: text(template.default_shared_with.join(", ")) },
      ],
    },
    {
      title: "Roles",
      rows: template.members.map((entry) => ({
        label: templates.memberLabel(entry),
        value: [templates.memberSelection(entry), `${entry.available} available`].filter(Boolean).join(" · "),
        mono: true,
      })),
    },
  ];
  if (template.constraints.length > 0) {
    sections.push({
      title: "Constraints",
      rows: template.constraints.map((constraint) => ({
        label: constraint.member_names.join(", "),
        value: constraint.same_label ? `same ${constraint.same_label}` : EMPTY,
        mono: true,
      })),
    });
  }
  if (template.forwards.length > 0) {
    sections.push({
      title: "Forwards",
      rows: template.forwards.map((forward) => ({
        label: forward.name,
        value: describeForward(forward),
        mono: true,
      })),
    });
  }
  if (template.docs.length > 0) {
    sections.push({
      title: "Docs",
      rows: template.docs.map((doc) => ({ label: "Link", value: doc, mono: true })),
    });
  }
  if (template.instructions) {
    sections.push({ title: "Instructions", rows: [], text: template.instructions.trim() });
  }
  return sections;
}

export function buildSections(selection: DetailsSelection): DetailSection[] {
  switch (selection.kind) {
    case "client":
      return buildClientSections(selection.client);
    case "exporter":
      return buildExporterSections(selection.exporter);
    case "lease":
      return buildLeaseSections(selection.lease);
    case "leaseTemplate":
      return buildLeaseTemplateSections(selection.template);
  }
}

export function selectionTitle(selection: DetailsSelection): string {
  switch (selection.kind) {
    case "client":
      return selection.client.alias;
    case "exporter":
      return selection.exporter.name;
    case "lease":
      return selection.lease.name;
    case "leaseTemplate":
      return selection.template.name;
  }
}

function renderSection(section: DetailSection): string {
  const rows = section.rows
    .map(
      (row) =>
        `<div class="row"><span class="label">${escapeHtml(row.label)}</span>` +
        `<span class="value${row.mono ? " mono" : ""}">${escapeHtml(row.value)}</span></div>`,
    )
    .join("");
  const plain = section.text ? `<pre class="text">${escapeHtml(section.text)}</pre>` : "";
  return `<section><h2>${escapeHtml(section.title)}</h2>${rows}${plain}</section>`;
}

const STYLE = `
  body {
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    margin: 0;
    padding: 8px 12px 14px;
  }
  h1 {
    font-size: 1.05em;
    font-weight: 600;
    margin: 2px 0 10px;
    overflow-wrap: anywhere;
  }
  h2 {
    font-size: 0.78em;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin: 14px 0 4px;
  }
  section:first-of-type h2 { margin-top: 4px; }
  .row {
    display: grid;
    grid-template-columns: minmax(90px, 34%) 1fr;
    gap: 10px;
    padding: 2px 0;
    align-items: baseline;
  }
  .label { color: var(--vscode-descriptionForeground); }
  .value { overflow-wrap: anywhere; }
  .mono {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.95em;
  }
  .text {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 2px 0;
  }
  .empty {
    color: var(--vscode-descriptionForeground);
    padding: 10px 0;
  }
`;

function document(body: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    '<meta http-equiv="Content-Security-Policy" ',
    "content=\"default-src 'none'; style-src 'unsafe-inline';\">",
    `<style>${STYLE}</style></head><body>${body}</body></html>`,
  ].join("");
}

/** Full webview HTML for a selection, or the placeholder when nothing is selected. */
export function renderDetailsHtml(selection: DetailsSelection | null): string {
  if (!selection) {
    return document(
      '<p class="empty">Select a client, exporter, lease or lease template to see its details.</p>',
    );
  }
  const heading = `<h1>${escapeHtml(selectionTitle(selection))}</h1>`;
  const sections = buildSections(selection).map(renderSection).join("");
  return document(heading + sections);
}
