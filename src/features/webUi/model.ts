/**
 * Pure logic for opening a lease in Jumpstarter Web (no vscode imports).
 *
 * Jumpstarter Web (`jumpstarter-web`, a separate optional package) serves a
 * lease's screen, Appium Inspector and tool windows as a web page. The
 * extension starts its `serve` command inside the lease session and opens a
 * deep link to it, narrowed to the views that have no native VS Code
 * counterpart; terminals, the driver tree and lease actions stay native.
 */

import * as path from "path";

/** A view a plugin of Jumpstarter Web has for a kind of driver client. */
export interface WebView {
  /** The id a link names it by: `<plugin id>/<contribution id>`. */
  id: string;
  /** The plugin that contributes it. */
  plugin: string;
  /** What its tab is called, e.g. "Screen". */
  title: string;
  /** The driver client classes it is a view of. */
  matches: string[];
  /** When set, only drivers with one of these names (the last segment of their path) have it. */
  names?: string[];
  /** The name of its tab's icon in Jumpstarter Web ("display", "tools"), when it has one. */
  icon?: string;
  /** What kind of centre view it is, when the listing says: a device's display, or a tool. */
  kind?: "display" | "tool";
}

/** A view of one driver of a lease. */
export interface DriverView {
  driverPath: readonly string[];
  /** What the driver is called (the last part of its path). */
  label: string;
  view: WebView;
}

/**
 * The view a lease is opened with: its device's display, the first there is, since that is what a person
 * looks at; a lease with no display opens with its first tool. Undefined when no driver has a view. The other
 * views are opened from their drivers.
 */
export function primaryView(candidates: readonly DriverView[]): DriverView | undefined {
  return candidates.find((candidate) => candidate.view.kind === "display") ?? candidates[0];
}

/**
 * The icon of a panel's tab, for a view's own icon name: one of the SVGs in
 * media/icons (`view-<name>-light.svg` and `-dark.svg`).
 */
export function panelIconName(icon: string | undefined): "display" | "tools" | "view" {
  return icon === "display" ? "display" : icon === "tools" ? "tools" : "view";
}

/**
 * The centre views of the installed, loadable plugins, from
 * `jumpstarter-web plugins -o json`: a device's display, a tool such as the
 * Appium Inspector. Everything else has a native counterpart here and is left
 * out: a terminal view (a serial or SSH console) is a VS Code terminal, and
 * tool windows and toolbar items belong to a workbench, not to a panel of
 * their own. Anything malformed is skipped rather than trusted.
 */
export function parsePluginViews(stdout: string): WebView[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const plugins = (parsed as { plugins?: unknown })?.plugins;
  if (!Array.isArray(plugins)) {
    return [];
  }
  const views: WebView[] = [];
  for (const plugin of plugins as Record<string, unknown>[]) {
    if (!plugin || plugin.compatible === false || typeof plugin.id !== "string" || !Array.isArray(plugin.views)) {
      continue;
    }
    for (const view of plugin.views as Record<string, unknown>[]) {
      if (!view || view.type !== "main" || typeof view.id !== "string" || !ENTRY.test(view.id)) {
        continue;
      }
      // (a listing that does not say the kind predates it: its main views are taken as they are)
      if (view.kind === "terminal") {
        continue;
      }
      // Conditions that cannot be checked from the CLI's driver tree (every class of a chain, a driver's
      // labels): better not to offer the view than to offer one the page will not show.
      if (view.all !== undefined || view.labels !== undefined) {
        continue;
      }
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((m): m is string => typeof m === "string") : [];
      const names = strings(view.names);
      views.push({
        id: view.id,
        plugin: plugin.id,
        title: typeof view.title === "string" && view.title ? view.title : view.id,
        matches: strings(view.matches),
        ...(names.length > 0 ? { names } : {}),
        ...(typeof view.icon === "string" && /^[a-z0-9-]{1,40}$/.test(view.icon) ? { icon: view.icon } : {}),
        ...(view.kind === "display" || view.kind === "tool" ? { kind: view.kind } : {}),
      });
    }
  }
  return views;
}

/**
 * The views there are for a driver, by its client class.
 *
 * Only the class the CLI reports is compared. A client that subclasses a
 * matched one is therefore not recognized here, though the page itself (which
 * sees the whole class chain) shows its view.
 */
export function viewsForDriver(
  driverClass: string,
  driverPath: readonly string[],
  views: readonly WebView[],
): WebView[] {
  const name = driverPath[driverPath.length - 1] ?? "";
  return views.filter(
    (view) => view.matches.includes(driverClass) && (view.names === undefined || view.names.includes(name)),
  );
}

/** What `jumpstarter-web serve` prints once it listens. */
const READY = /^jumpstarter-web: (https?:\/\/\S+)\s*$/m;

/** One entry of the tools list: an extension id, an instance of one, a plugin id, or a kind of main view. */
const ENTRY = /^(?:@(?:display|terminal|tool)|[A-Za-z0-9._\-/#]{1,200})$/;

/**
 * What the focused link shows when the setting is left alone and the
 * installed plugins are not known: the centre views that are a display or a
 * tool. Terminals, the driver tree and the tool windows have native
 * counterparts in VS Code.
 */
export const DEFAULT_TOOLS: readonly string[] = ["@display", "@tool"];

/**
 * What the focused link shows when the setting is left alone: the plugins
 * that have a centre view to show (each with what it has around that view),
 * as the installed Jumpstarter Web lists them.
 */
export function defaultTools(views: readonly WebView[]): string[] {
  const plugins = [...new Set(views.map((view) => view.plugin))].sort();
  return plugins.length > 0 ? plugins : [...DEFAULT_TOOLS];
}

/** How long `serve` may take to print its address (it attaches to the lease first). */
export const START_TIMEOUT_MS = 60_000;

/** The address the server announced, or undefined while it has not listened yet. */
export function parseReadyUrl(output: string): string | undefined {
  return READY.exec(output)?.[1];
}

/**
 * The tools setting as a clean list: trimmed, deduplicated, and without
 * entries the page would not understand (they would otherwise end up in a URL).
 */
export function normalizeTools(setting: unknown, views: readonly WebView[] = []): string[] {
  if (!Array.isArray(setting)) {
    return defaultTools(views);
  }
  const seen = new Set<string>();
  for (const value of setting) {
    if (typeof value !== "string") {
      continue;
    }
    const entry = value.trim();
    if (ENTRY.test(entry)) {
      seen.add(entry);
    }
  }
  return [...seen];
}

/**
 * How much of the page is around the views: `minimal` keeps a title bar with
 * the device's name (a browser tab); `none` is the views alone (a panel of
 * this window, which has a title, tabs and a status bar itself).
 */
export type Chrome = "minimal" | "none";

export interface WebUiLinkOptions {
  /** Show only these extensions (`only=`). Empty or absent: the full workbench. */
  tools?: readonly string[];
  /** How much of the page's own chrome to keep; absent: all of it. */
  chrome?: Chrome;
}

/**
 * The link to open: the server's address plus a device deep link in the hash.
 *
 * The address may carry a one-time `?token=` in its query; that stays where it
 * is. Nothing secret is ever put in the hash.
 */
export function buildWebUiLink(serverUrl: string, options: WebUiLinkOptions = {}): string {
  const url = new URL(serverUrl);
  const parts: string[] = [];
  const tools = options.tools ?? [];
  if (tools.length > 0) {
    parts.push(`only=${tools.map((entry) => encodeURIComponent(entry)).join(",")}`);
  }
  if (options.chrome) {
    parts.push(`chrome=${options.chrome}`);
  }
  url.hash = parts.length > 0 ? `#/d/?${parts.join("&")}` : "#/d/";
  return url.toString();
}

/** The window of Jumpstarter Web that shows the other roles of a lease with members beside the first. */
export const COMPANIONS_WINDOW = "shell/companions";

/**
 * The link to a lease with members: ONE view for the lease, with all its
 * roles. Jumpstarter Web shows such a lease as one device (the primary role,
 * which the page chooses) with the other roles beside it, in its Companions
 * window, together with what the lease says of its roles and forwards. A
 * link that names what to show (`only=`) therefore names that window too, or
 * the page would show the primary role and nothing of the others.
 */
export function buildMemberLeaseLink(serverUrl: string, options: WebUiLinkOptions = {}): string {
  const tools = options.tools ?? [];
  return buildWebUiLink(serverUrl, {
    ...options,
    tools: tools.length > 0 && !tools.includes(COMPANIONS_WINDOW) ? [...tools, COMPANIONS_WINDOW] : tools,
  });
}

/**
 * Runs a command as one role of a lease with members, inside the lease's
 * shell: the command then sees that role's exporter as a `jmp shell` on a
 * lease of one exporter would give it (`JUMPSTARTER_HOST` is the role's
 * socket), which is how `jumpstarter-web serve` shows one role alone.
 *
 * Jumpstarter Web's own links have no way to name a role of a lease (its
 * lease view picks the role it shows first), so a view of one role's driver
 * is served by a server of that role. `JMP_LEASE_MEMBERS` is the shell's:
 * each role's `socket`, `exporter` and `labels`.
 */
export const ROLE_SESSION_SCRIPT = [
  "import json, os, sys",
  "role = sys.argv[1]",
  "entry = json.loads(os.environ.get('JMP_LEASE_MEMBERS') or '{}').get(role)",
  "if not isinstance(entry, dict) or not entry.get('socket'):",
  "    sys.exit(f\"jumpstarter: the role '{role}' has no exporter in this lease\")",
  "os.environ['JUMPSTARTER_HOST'] = entry['socket']",
  "os.environ['JMP_EXPORTER'] = entry.get('exporter') or ''",
  "os.environ['JMP_EXPORTER_LABELS'] = ','.join(f'{k}={v}' for k, v in (entry.get('labels') or {}).items())",
  "os.execvp(sys.argv[2], sys.argv[2:])",
].join("\n");

/** The command, for inside the lease's shell, that runs `command` as the role. */
export function buildRoleCommand(python: string, role: string, command: readonly string[]): string[] {
  return [python, "-c", ROLE_SESSION_SCRIPT, role, ...command];
}

/** What a server is the server of: a lease, or one role of a lease with members. */
export function serverKey(lease: string, role?: string): string {
  return role ? `${lease}\u0000${role}` : lease;
}

/**
 * The link to one driver's view, alone: the driver's page, that view in
 * front, and only what its plugin has for it around it (the Appium
 * Inspector's source tree is a window beside its view, and VS Code has
 * nothing of its own for it). The lease's terminals, driver tree and other
 * tool windows, which VS Code does have, are left out.
 */
export function buildDriverViewLink(
  serverUrl: string,
  driverPath: readonly string[],
  view: WebView,
  chrome: Chrome = "minimal",
  alone = false,
): string {
  const url = new URL(serverUrl);
  const path = driverPath.map((segment) => encodeURIComponent(segment)).join("/");
  const instance = encodeURIComponent(`${view.id}#${driverPath.join("/")}`);
  url.hash = `#/d/${path}?view=${instance}&only=${encodeURIComponent(alone ? view.id : view.plugin)}&chrome=${chrome}`;
  return url.toString();
}

export interface ServeOptions {
  /** The port to listen on. */
  port: number;
  /**
   * The address to listen on; loopback unless the port is reached from
   * outside the machine itself (an endpoint of a workspace's container).
   */
  host?: string;
  /**
   * The origin the browser reaches that port through when it is not loopback
   * itself (a forwarded port in a remote window, a Che endpoint).
   */
  publicUrl?: string;
  /**
   * What may show the page in a frame: origins, or an application's scheme
   * (`vscode-webview:` for a panel of a desktop window).
   */
  frameOrigins?: readonly string[];
}

/**
 * Arguments for `jumpstarter-web serve`, after the executable.
 *
 * With a public URL the server is reached from beyond loopback, so it asks for
 * its per-launch token. Terminals stay on: a serial or SSH console is a view
 * of a driver like the screen is, and the links opened here leave the page's
 * own `jmp shell` tab out.
 */
export function buildServeArgs(options: ServeOptions): string[] {
  const args = ["serve", "--host", options.host ?? "127.0.0.1", "--port", String(options.port)];
  if (options.publicUrl) {
    args.push("--public-url", options.publicUrl, "--auth", "token");
  }
  for (const origin of options.frameOrigins ?? []) {
    args.push("--allowed-frame-origin", origin);
  }
  return args;
}

/**
 * How to run `jumpstarter-web`, given how `jmp` is run.
 *
 * - An explicit path setting wins.
 * - `<python> -m jumpstarter_cli` mode: the same interpreter runs the module,
 *   so the web UI always comes from the environment jmp came from.
 * - A `jmp` executable: the script that sits beside it (the same environment's
 *   bin directory), found by the caller; else the bare name, left to PATH.
 */
export function resolveWebCommand(
  jmp: { command: string; prefixArgs: readonly string[] },
  configuredPath: string,
  exists: (file: string) => boolean,
): string[] {
  const configured = configuredPath.trim();
  if (configured.length > 0) {
    return [configured];
  }
  if (jmp.prefixArgs.length > 0) {
    return [jmp.command, "-m", "jumpstarter_web"];
  }
  const beside = path.join(path.dirname(jmp.command), "jumpstarter-web");
  return [exists(beside) ? beside : "jumpstarter-web"];
}

/** A port of this machine that an address outside it leads to. */
export interface WebEndpoint {
  port: number;
  /** The origin a browser reaches the port at. */
  url: string;
}

/**
 * The endpoints Jumpstarter Web may be served on, where a browser cannot
 * reach this machine's loopback: a workspace in the browser (Eclipse Che,
 * code-server), whose container has ports that the platform gives addresses
 * of their own. From the setting (`{"7071": "https://…"}`) or, as a
 * workspace's definition gives it, from the environment
 * (`7071=https://…,7072=https://…`). Anything that is not a port and an
 * http(s) origin is left out.
 */
export function parseEndpoints(setting: unknown, environment: string | undefined): WebEndpoint[] {
  const pairs: [string, unknown][] =
    setting !== null && typeof setting === "object" && !Array.isArray(setting) && Object.keys(setting).length > 0
      ? Object.entries(setting)
      : (environment ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.includes("="))
          .map((entry): [string, unknown] => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]);
  const endpoints: WebEndpoint[] = [];
  for (const [key, value] of pairs) {
    const port = Number(key.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof value !== "string") {
      continue;
    }
    try {
      const url = new URL(value.trim());
      if (url.protocol === "https:" || url.protocol === "http:") {
        endpoints.push({ port, url: url.origin });
      }
    } catch {
      // not an address: left out
    }
  }
  return endpoints;
}

/** An entry of the frame origins setting the server will take: an http(s) origin, or a scheme with its colon. */
const FRAME_ORIGIN = /^(?:[a-z][a-z0-9+.-]*:|https?:\/\/[a-z0-9.-]+(?::\d{1,5})?)$/;

/**
 * What frames a panel in a desktop window. Every ancestor of a frame has to
 * be allowed, and there are two: the webview's own document, and the window
 * the webview is part of.
 */
export const DESKTOP_FRAME_ORIGINS: readonly string[] = ["vscode-webview:", "vscode-file:"];

/** The frame origins setting as a clean list; anything the server would refuse is left out. */
export function normalizeFrameOrigins(setting: unknown, environment?: string): string[] {
  if (!Array.isArray(setting)) {
    // a workspace's definition says where its editor's panels are served from; else it is a desktop window
    const given = (environment ?? "").split(",").filter((entry) => entry.trim().length > 0);
    return given.length > 0 ? normalizeFrameOrigins(given) : [...DESKTOP_FRAME_ORIGINS];
  }
  const seen = new Set<string>();
  for (const value of setting) {
    if (typeof value === "string" && FRAME_ORIGIN.test(value.trim().toLowerCase())) {
      seen.add(value.trim().toLowerCase());
    }
  }
  return [...seen];
}

/** The origin (`scheme://host[:port]`) of a URL, as `--public-url` wants it. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/** Whether a URL points at this machine's loopback interface. */
export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** The last lines of a process's output, for an error message. */
export function tail(output: string, lines = 8): string {
  return output.trim().split("\n").slice(-lines).join("\n");
}

/** What a panel is, kept by VS Code with it so that it can be made again when the window is loaded again. */
export interface PanelState {
  client: string;
  lease: string;
  /** The role whose server the view is of, for a view of one role of a lease with members. */
  role?: string;
  /** The page's route, the part of the link after `#`: nothing of it is secret. */
  route: string;
  title: string;
  icon?: string;
}

/** The state of a panel for a link (the link's own address and token are not kept: they are the server's). */
export function panelState(
  client: string,
  lease: string,
  link: string,
  title: string,
  icon?: string,
  role?: string,
): PanelState {
  return { client, lease, ...(role ? { role } : {}), route: new URL(link).hash, title, ...(icon ? { icon } : {}) };
}

/** A kept state, if it is one: every field of the right kind, and a route that is a device link. */
export function parsePanelState(value: unknown): PanelState | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const { client, lease, role, route, title, icon } = value as Record<string, unknown>;
  if (typeof client !== "string" || typeof lease !== "string" || typeof title !== "string") {
    return undefined;
  }
  if (typeof route !== "string" || !route.startsWith("#/d/") || route.length > 2000) {
    return undefined;
  }
  return {
    client,
    lease,
    // (a role is a DNS label; anything else was not written by this extension)
    ...(typeof role === "string" && /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(role) ? { role } : {}),
    route,
    title,
    ...(typeof icon === "string" ? { icon } : {}),
  };
}

/** A server's address with a kept route. */
export function linkFor(serverUrl: string, route: string): string {
  const url = new URL(serverUrl);
  url.hash = route;
  return url.toString();
}

/** Whether a server that ended before it listened did so because its port was taken. */
export function portTaken(message: string): boolean {
  return /address already in use|EADDRINUSE|Errno 98|Errno 48/i.test(message);
}
