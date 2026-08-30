/**
 * Pure (VS Code-free) logic for the Clients feature: tree row building, auth
 * badges, argument construction for login / client create, input validation
 * and secret redaction. Everything here is unit-testable under plain Node —
 * do NOT import "vscode" in this file.
 */

import { AuthStatus, AuthStatusValue, ClientConfigList } from "../../types";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One row of the Clients tree, derived from config list + auth statuses. */
export interface ClientRow {
  alias: string;
  isCurrent: boolean;
  endpoint: string;
  /** Absolute path of clients/<alias>.yaml. */
  path: string;
  namespace: string;
  name: string;
  /** Auth status, when it could be fetched. */
  auth: AuthStatus | undefined;
  /** Human-readable message when the auth check itself failed. */
  authError: string | undefined;
}

/**
 * Merge `jmp config client list` output with per-alias auth statuses into
 * sorted rows (alphabetical by alias, case-insensitive — stable across
 * current-client switches).
 */
export function buildClientRows(
  list: ClientConfigList,
  auth: ReadonlyMap<string, AuthStatus> = new Map(),
  authErrors: ReadonlyMap<string, string> = new Map(),
): ClientRow[] {
  return [...list.items]
    .sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: "base" }))
    .map((item) => ({
      alias: item.alias,
      isCurrent: list.currentConfig !== null && item.alias === list.currentConfig,
      endpoint: item.endpoint,
      path: item.path,
      namespace: item.metadata?.namespace ?? "",
      name: item.metadata?.name ?? "",
      auth: auth.get(item.alias),
      authError: authErrors.get(item.alias),
    }));
}

// ---------------------------------------------------------------------------
// Auth badges
// ---------------------------------------------------------------------------

export type AuthSeverity = "ok" | "warn" | "bad" | "unknown";

export interface AuthBadge {
  /** Codicon name (without $()). */
  icon: string;
  /** ThemeColor id, or undefined for the default foreground. */
  color: string | undefined;
  /** Short human label, e.g. "token expired". */
  label: string;
  severity: AuthSeverity;
}

/** Map an auth status (undefined = could not be determined) to a badge. */
export function authBadge(status: AuthStatusValue | undefined): AuthBadge {
  switch (status) {
    case "valid":
    case "no-expiry":
      return { icon: "key", color: "charts.green", label: "auth valid", severity: "ok" };
    case "expiring-soon":
      return {
        icon: "warning",
        color: "charts.yellow",
        label: "token expiring soon",
        severity: "warn",
      };
    case "expired":
      return { icon: "error", color: "charts.red", label: "token expired", severity: "bad" };
    case "no-token":
      return { icon: "circle-slash", color: "charts.red", label: "not logged in", severity: "bad" };
    case "invalid-token":
      return { icon: "error", color: "charts.red", label: "invalid token", severity: "bad" };
    default:
      return { icon: "question", color: undefined, label: "auth unknown", severity: "unknown" };
  }
}

/**
 * Row icon: a filled blue star marks the current client, an empty star every
 * other one — the same mark as the "set as current" action, so a row shows
 * what pressing that button would make it. Authentication trouble stays
 * visible in the row description, the tooltip and the re-authenticate button.
 */
export function clientRowIcon(row: ClientRow): { icon: string; color: string | undefined } {
  return row.isCurrent
    ? { icon: "star-full", color: "charts.blue" }
    : { icon: "star-empty", color: undefined };
}

/** True when the status calls for an interactive re-login. */
export function needsReauth(status: AuthStatusValue | undefined): boolean {
  return status === "expired" || status === "no-token" || status === "invalid-token";
}

/** Gray description text next to the alias in the tree. */
export function rowDescription(row: ClientRow): string {
  const badge = authBadge(row.auth?.status);
  const parts: string[] = [];
  if (row.isCurrent) {
    parts.push("current");
  }
  if (badge.severity !== "ok") {
    parts.push(badge.label);
  }
  if (row.endpoint) {
    parts.push(row.endpoint);
  }
  return parts.join(" · ");
}

/**
 * contextValue for when-clause targeting. Always starts with
 * "jumpstarterClient"; "Current" is appended for the active client and
 * "NeedsAuth" when the token is expired/missing/invalid.
 *   Menus: /^jumpstarterClient/ = any client row;
 *          /^jumpstarterClient(NeedsAuth)?$/ = non-current rows;
 *          /NeedsAuth/ = rows needing re-authentication.
 */
export function rowContextValue(row: ClientRow): string {
  let v = "jumpstarterClient";
  if (row.isCurrent) {
    v += "Current";
  }
  if (needsReauth(row.auth?.status)) {
    v += "NeedsAuth";
  }
  return v;
}

/** Markdown lines for the row tooltip. Never includes token material. */
export function rowTooltipLines(row: ClientRow): string[] {
  const badge = authBadge(row.auth?.status);
  const lines: string[] = [`**${row.alias}**${row.isCurrent ? " (current client)" : ""}`];
  if (row.endpoint) {
    lines.push(`Endpoint: ${row.endpoint}`);
  }
  if (row.namespace || row.name) {
    lines.push(`Identity: ${row.namespace}/${row.name}`);
  }
  lines.push(`Auth: ${badge.label}`);
  if (row.auth?.expiresAt) {
    lines.push(`Expires: ${row.auth.expiresAt}`);
  }
  if (row.auth?.subject) {
    lines.push(`Subject: ${row.auth.subject}`);
  }
  if (row.authError) {
    lines.push(`Auth check failed: ${row.authError}`);
  }
  if (row.path) {
    lines.push(`Config: ${row.path}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Login / create arguments
// ---------------------------------------------------------------------------

/** `jmp login [name@]endpoint` — run in a terminal (interactive OIDC flow). */
export function buildLoginArgs(target: string): string[] {
  return ["login", target.trim()];
}

/** `jmp login --client <alias>` — re-authenticate an existing client. */
export function buildReauthArgs(alias: string): string[] {
  return ["login", "--client", alias];
}

export interface TokenClientOptions {
  alias: string;
  namespace: string;
  name: string;
  endpoint: string;
  token: string;
}

/**
 * `jmp config client create <alias> ... --nointeractive` with every flag
 * passed explicitly so the CLI never prompts. `-a ""` = no drivers allowed
 * yet (the user can widen it in the YAML).
 * WARNING: the result contains the raw token — redact with redactSecretArgs()
 * before logging or displaying.
 */
export function buildClientCreateArgs(opts: TokenClientOptions): string[] {
  return [
    "config",
    "client",
    "create",
    opts.alias,
    "--namespace",
    opts.namespace,
    "--name",
    opts.name,
    "-e",
    opts.endpoint,
    "-t",
    opts.token,
    "-a",
    "",
    "--nointeractive",
  ];
}

// Secret redaction lives in the shared protocol layer (JmpService.run applies
// it to every argv before logging or embedding in a JmpError); re-exported
// here for convenience and for the unit tests.
export { redactSecretArgs } from "../../services/jmpProtocol";

// ---------------------------------------------------------------------------
// Input validation (return an error message, or undefined when valid — the
// shape vscode.InputBoxOptions.validateInput expects)
// ---------------------------------------------------------------------------

const ALIAS_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

/** Client aliases become file names (clients/<alias>.yaml) — keep them tame. */
export function validateAlias(value: string): string | undefined {
  const v = value.trim();
  if (v.length === 0) {
    return "Alias is required";
  }
  if (!ALIAS_RE.test(v)) {
    return "Use letters, digits, '.', '_' or '-' (must start and end with a letter or digit)";
  }
  return undefined;
}

/** Generic required-field validator factory. */
export function validateRequired(field: string): (value: string) => string | undefined {
  return (value: string) => (value.trim().length === 0 ? `${field} is required` : undefined);
}

/**
 * Validate a `[name@]endpoint` login target. Returns an error message or
 * undefined when acceptable.
 */
export function validateLoginTarget(value: string): string | undefined {
  const v = value.trim();
  if (v.length === 0) {
    return "Endpoint is required (e.g. jumpstarter.example.com or myclient@jumpstarter.example.com)";
  }
  if (/\s/.test(v)) {
    return "Endpoint must not contain whitespace";
  }
  const at = v.indexOf("@");
  if (at === 0) {
    return "Missing client name before '@'";
  }
  if (at === v.length - 1) {
    return "Missing endpoint after '@'";
  }
  if (at !== v.lastIndexOf("@")) {
    return "Only one '@' is allowed";
  }
  return undefined;
}

/** Split a validated `[name@]endpoint` target. */
export function parseLoginTarget(value: string): { name?: string; endpoint: string } {
  const v = value.trim();
  const at = v.indexOf("@");
  if (at > 0) {
    return { name: v.slice(0, at), endpoint: v.slice(at + 1) };
  }
  return { endpoint: v };
}

// ---------------------------------------------------------------------------
// Quick pick items
// ---------------------------------------------------------------------------

/** Data for the client QuickPick (status bar click / Switch Client). */
export interface ClientPickEntry {
  alias: string;
  label: string;
  description: string;
  detail: string | undefined;
}

export function buildClientPickEntries(rows: readonly ClientRow[]): ClientPickEntry[] {
  return rows.map((row) => {
    const badge = authBadge(row.auth?.status);
    return {
      alias: row.alias,
      label: `$(${badge.icon}) ${row.alias}`,
      description: [row.isCurrent ? "current" : undefined, badge.severity === "ok" ? undefined : badge.label]
        .filter((p): p is string => p !== undefined)
        .join(" · "),
      detail: row.endpoint || undefined,
    };
  });
}
