/**
 * Web UI feature: open a lease in Jumpstarter Web.
 *
 * - `jumpstarter.leases.openWebUi` opens the lease's screen (its primary
 *   view) in a panel: the part of a lease VS Code has no view for.
 * - `jumpstarter.leases.openDriverView` opens one driver's own view (a
 *   screen, an Appium Inspector, a console), offered on the drivers whose
 *   client an installed Jumpstarter Web plugin has a view for.
 * - `jumpstarter.leases.openFullWebUi` opens the whole workbench in the
 *   browser.
 *
 * The first two open in a panel beside the editor (`jumpstarter.webUi.openIn`):
 * a webview that frames the page and passes it the window's theme, so the view
 * looks like the rest of VS Code (./webUi/panel.ts). The setting sends them to
 * the system browser instead.
 * - `jumpstarter.webUi.stop` stops the servers this window started.
 *
 * One `jumpstarter-web serve` runs per lease, inside that lease's session
 * (`jmp shell --lease L -- jumpstarter-web serve`), started the first time it
 * is asked for and reused after. It listens on loopback only. In a remote
 * window or a Che workspace the port is reached through whatever
 * `vscode.env.asExternalUri` maps it to, and the server is told that address
 * so it accepts it and asks for its per-launch token.
 */

import * as vscode from "vscode";
import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import { createServer } from "net";
import { Services } from "../services";
import { buildShellArgs, shellQuote } from "../services/jmpProtocol";
import { Lease } from "../types";
import { buildDriverNodes } from "./leases/model";
import type { DriverNodeDescriptor } from "./leases/model";
import type { DriverNode, LeasesTreeProvider } from "./leases/provider";
import * as model from "./webUi/model";
import { buildMessageHtml, buildPanelHtml } from "./webUi/panel";
import { randomBytes } from "crypto";

/** The type of a Jumpstarter panel: what VS Code restores them by. */
const PANEL_TYPE = "jumpstarter.webView";

/** Whose view a panel shows. */
interface LeaseOwner {
  client: string;
  lease: string;
}

interface LeaseRef {
  client: string;
  lease: Lease;
}

interface RunningServer {
  process: ChildProcess;
  /** The port it listens on. */
  port: number;
  /** The address the server printed (with its token, when it uses one). */
  url: string;
}

/** What the extension exposes of this feature (to the integration tests). */
export interface WebUiApi {
  /** The address of the lease's running server, if this window started one. */
  serverUrl(leaseName: string): string | undefined;
  stopAll(): void;
  /** The links shown in panels of this window, oldest first. */
  panelLinks(): string[];
  /** The document of the panel that shows a link, if one does. */
  panelHtml(link: string): string | undefined;
  closePanels(): void;
  /** Ask the environment again which plugin views there are, and settle. */
  refreshViews(): Promise<void>;
}

/** A free loopback port. Chosen here, not by the server, so its external address is known before it starts. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

export function registerWebUi(
  context: vscode.ExtensionContext,
  services: Services,
  leases: LeasesTreeProvider,
): WebUiApi {
  const { jmp } = services;

  const webCommand = async (): Promise<string[]> => {
    const configured = vscode.workspace.getConfiguration("jumpstarter").get<string>("webUi.path", "");
    return model.resolveWebCommand(await jmp.getInvocation(), configured, existsSync);
  };

  // -- which drivers have a view --------------------------------------------

  let views: model.WebView[] = [];
  /**
   * Ask the environment which plugin views are installed. Quiet on failure:
   * Jumpstarter Web is optional, and without it (or with one too old to list
   * its plugins) drivers simply offer nothing to open.
   */
  const refreshViews = async (): Promise<void> => {
    let found: model.WebView[] = [];
    try {
      const [command, ...prefixArgs] = await webCommand();
      const result = await jmp.run(["plugins", "-o", "json"], {
        invocation: { command, prefixArgs },
        timeoutMs: 20_000,
      });
      found = model.parsePluginViews(result.stdout);
    } catch {
      found = [];
    }
    views = found;
    leases.setWebViewLookup(
      (driverClass, driverPath) => model.viewsForDriver(driverClass, driverPath, views).length > 0,
    );
  };
  context.subscriptions.push(
    jmp.onDidChangeAvailability(() => void refreshViews()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("jumpstarter.webUi.path")) {
        void refreshViews();
      }
    }),
  );

  const servers = new Map<string, RunningServer>();
  const starting = new Map<string, Promise<RunningServer>>();
  /** Endpoint ports that turned out to be taken by something that is not this window's. */
  const busyPorts = new Set<number>();
  /** The ports of the servers that are starting, by lease: taken, though not in `servers` yet. */
  const startingPorts = new Map<string, number>();

  const stop = (leaseName: string): void => {
    const server = servers.get(leaseName);
    servers.delete(leaseName);
    if (server) {
      closePanelsOf(server.url);
    }
    if (!server || server.process.exitCode !== null) {
      return;
    }
    // The server is a grandchild (jmp shell runs it); end the whole group.
    try {
      if (server.process.pid !== undefined && process.platform !== "win32") {
        process.kill(-server.process.pid, "SIGTERM");
      } else {
        server.process.kill();
      }
    } catch {
      server.process.kill();
    }
  };

  const stopAll = (): void => {
    for (const name of [...servers.keys()]) {
      stop(name);
    }
  };
  context.subscriptions.push({ dispose: stopAll });

  const start = async (client: string, leaseName: string): Promise<RunningServer> => {
    const invocation = await jmp.getInvocation();
    const web = await webCommand();

    const config = vscode.workspace.getConfiguration("jumpstarter");
    // Where a browser cannot reach this machine's loopback (a workspace in the browser), the server listens on
    // one of the ports the workspace has addresses for; each lease's server takes one.
    const endpoints = model.parseEndpoints(config.get("webUi.endpoints"), process.env.JUMPSTARTER_WEB_ENDPOINTS);
    let port: number;
    let host: string | undefined;
    let publicUrl: string | undefined;
    if (endpoints.length > 0) {
      const taken = new Set([...servers.values(), ...startingPorts.values()].map((s) => (typeof s === "number" ? s : s.port)));
      const endpoint = endpoints.find((candidate) => !taken.has(candidate.port) && !busyPorts.has(candidate.port));
      if (!endpoint) {
        throw new Error(
          `All ${endpoints.length} Web UI endpoints of this workspace are in use: close a lease's views (Stop Web UI Servers) to open another's.`,
        );
      }
      port = endpoint.port;
      host = "0.0.0.0";
      publicUrl = endpoint.url;
    } else {
      port = await freePort();
      const local = `http://127.0.0.1:${port}`;
      const external = (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString();
      publicUrl = model.originOf(external) === local ? undefined : model.originOf(external);
    }
    startingPorts.set(leaseName, port);

    const frameOrigins = model.normalizeFrameOrigins(
      config.get("webUi.frameOrigins"),
      process.env.JUMPSTARTER_WEB_FRAME_ORIGINS,
    );
    const serve = [...web, ...model.buildServeArgs({ port, host, publicUrl, frameOrigins })];
    const args = [...invocation.prefixArgs, ...buildShellArgs(client, leaseName, serve)];
    jmp.log(`web UI: ${shellQuote([invocation.command, ...args])}`);

    const terminalEnv = await jmp.getTerminalEnv();
    const env: NodeJS.ProcessEnv = { ...process.env, ...terminalEnv, NO_COLOR: "1" };
    // A token of the user's own in the environment would make the server print an address without it.
    delete env.JUMPSTARTER_WEB_TOKEN;

    const child = spawn(invocation.command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    return new Promise<RunningServer>((resolve, reject) => {
      let output = "";
      let settled = false;
      const fail = (message: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(new Error(message));
      };
      const timer = setTimeout(() => {
        fail(
          `Jumpstarter Web did not start within ${model.START_TIMEOUT_MS / 1000} s.\n${model.tail(output)}`,
        );
        child.kill();
      }, model.START_TIMEOUT_MS);

      const onData = (data: Buffer): void => {
        // Only until the address is known: the server's token must not pile up in memory or reach a log.
        if (settled) {
          return;
        }
        output += data.toString();
        const url = model.parseReadyUrl(output);
        if (url) {
          settled = true;
          clearTimeout(timer);
          resolve({ process: child, url, port });
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (err: NodeJS.ErrnoException) => {
        fail(`Could not run jmp: ${err.message}`);
      });
      child.on("close", (code) => {
        if (servers.get(leaseName)?.process === child) {
          const gone = servers.get(leaseName);
          servers.delete(leaseName);
          if (gone) {
            closePanelsOf(gone.url);
          }
          jmp.log(`web UI of ${leaseName} exited (${code})`);
        }
        const missing = /No module named jumpstarter_web|jumpstarter-web.*(not found|No such file)/i.test(output);
        fail(
          missing
            ? "Jumpstarter Web is not installed in this environment. Install the `jumpstarter-web` package next to jumpstarter, or set `jumpstarter.webUi.path`."
            : `Jumpstarter Web exited (${code}) before it listened.\n${model.tail(output)}`,
        );
      });
    });
  };

  /**
   * Start the lease's server; where its port turns out to be taken (another window of the same workspace has a
   * server of its own on that endpoint), on the next endpoint, for as many as there are.
   */
  const startOnFreePort = async (client: string, leaseName: string): Promise<RunningServer> => {
    for (;;) {
      try {
        return await start(client, leaseName);
      } catch (err) {
        const port = startingPorts.get(leaseName);
        if (port === undefined || busyPorts.has(port) || !model.portTaken(err instanceof Error ? err.message : "")) {
          throw err;
        }
        busyPorts.add(port);
        jmp.log(`web UI: port ${port} is taken, trying the next endpoint`);
      }
    }
  };

  /** The lease's server, started if this window has none. Concurrent requests share one start. */
  const ensure = (client: string, leaseName: string): Promise<RunningServer> => {
    const running = servers.get(leaseName);
    if (running && running.process.exitCode === null) {
      return Promise.resolve(running);
    }
    let pending = starting.get(leaseName);
    if (!pending) {
      pending = startOnFreePort(client, leaseName)
        .then((server) => {
          servers.set(leaseName, server);
          return server;
        })
        .finally(() => {
          starting.delete(leaseName);
          startingPorts.delete(leaseName);
        });
      starting.set(leaseName, pending);
    }
    return pending;
  };

  const leaseOf = (node: unknown): LeaseRef | undefined => {
    const n = node as { kind?: string; client?: string; lease?: Lease } | undefined;
    if (n && n.kind === "lease" && n.lease && typeof n.client === "string") {
      return { client: n.client, lease: n.lease };
    }
    void vscode.window.showInformationMessage("Select a lease in the Jumpstarter Leases view first.");
    return undefined;
  };

  // -- panels -----------------------------------------------------------------

  /** The open panels, by the link each shows: asking for a view again brings its panel forward. */
  const panels = new Map<string, vscode.WebviewPanel>();
  context.subscriptions.push({
    dispose: () => {
      for (const panel of [...panels.values()]) {
        panel.dispose();
      }
    },
  });

  /** Put a view in a panel, and keep the panel for as long as it is open. */
  const fill = (panel: vscode.WebviewPanel, link: string, state: model.PanelState): void => {
    const name = model.panelIconName(state.icon);
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "icons", `view-${name}-light.svg`),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "icons", `view-${name}-dark.svg`),
    };
    panel.webview.html = buildPanelHtml({
      link,
      title: state.title,
      nonce: randomBytes(16).toString("hex"),
      state,
    });
    panels.set(link, panel);
    panel.onDidDispose(() => {
      if (panels.get(link) === panel) {
        panels.delete(link);
      }
    });
  };

  const showPanel = (link: string, owner: LeaseOwner, title: string, icon?: string): vscode.WebviewPanel => {
    const open = panels.get(link);
    if (open) {
      open.reveal();
      return open;
    }
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      title,
      // beside the editor; the views after the first are tabs of the same group, not a split each
      { viewColumn: [...panels.values()][0]?.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: false },
      // Kept when hidden: the view holds a live stream and a session, and a reload would drop both.
      { enableScripts: true, retainContextWhenHidden: true },
    );
    fill(panel, link, model.panelState(owner.client, owner.lease, link, title, icon));
    return panel;
  };

  // A window that is loaded again (a browser reload of a workspace, a restart) gets its panels back from VS
  // Code, empty: each is filled again from what it kept, once its lease's server is there (the one that still
  // runs, or a new one).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, kept: unknown): Promise<void> {
        const nonce = randomBytes(16).toString("hex");
        const state = model.parsePanelState(kept);
        panel.webview.options = { enableScripts: true };
        if (!state) {
          panel.webview.html = buildMessageHtml(nonce, "This Jumpstarter view cannot be opened again: open it from its lease.");
          return;
        }
        panel.webview.html = buildMessageHtml(nonce, `Opening ${state.title} again…`);
        try {
          const server = await ensure(state.client, state.lease);
          fill(panel, model.linkFor(server.url, state.route), state);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          panel.webview.html = buildMessageHtml(nonce, `${state.title} cannot be opened again: ${why}`);
        }
      },
    }),
  );

  /** Close the panels of a server that is gone: what they frame no longer answers. */
  const closePanelsOf = (serverUrl: string): void => {
    const origin = model.originOf(serverUrl);
    for (const [link, panel] of [...panels]) {
      if (model.originOf(link) === origin) {
        panel.dispose();
      }
    }
  };

  /**
   * Hand a link to the system browser. As a string: Uri.toString()
   * percent-encodes the `?`, `=` and `,` of the hash, which the page reads as
   * its route, and openExternal takes a string as it is.
   */
  const showInBrowser = async (link: string): Promise<void> => {
    const opened = await vscode.env.openExternal(link as unknown as vscode.Uri);
    if (!opened) {
      void vscode.window.showWarningMessage("Jumpstarter: the Web UI is running, but no browser could be opened.");
    }
  };

  const preferred = (): "panel" | "browser" =>
    vscode.workspace.getConfiguration("jumpstarter").get<string>("webUi.openIn", "panel") === "browser"
      ? "browser"
      : "panel";

  const serverFor = (client: string, leaseName: string): Thenable<RunningServer> =>
    vscode.window.withProgress(
      { location: { viewId: "jumpstarter.leases" }, title: "Starting Jumpstarter Web…" },
      () => ensure(client, leaseName),
    );

  const report = (err: unknown): void => {
    void vscode.window.showErrorMessage(`Jumpstarter: ${err instanceof Error ? err.message : String(err)}`);
  };

  /**
   * The lease's primary view (its screen) in a panel; whether there was one. Not when the driver tree cannot be
   * read (a CLI without driver browsing) or no driver has a view: the caller then shows the lease's views
   * together. A lease's other views are opened from their drivers in the tree: a second tab nobody asked for
   * is a surprise, and an Appium Inspector that opens by itself starts a session on the device.
   */
  const openPrimaryPanel = async (ref: LeaseRef, serverUrl: string): Promise<boolean> => {
    let drivers: DriverNodeDescriptor[];
    try {
      drivers = buildDriverNodes((await jmp.describeLeaseWithDrivers(ref.client, ref.lease.name)).driver_tree);
    } catch {
      return false;
    }
    const primary = model.primaryView(
      drivers.flatMap((driver) =>
        model
          .viewsForDriver(driver.driverClass, driver.driverPath, views)
          .map((view) => ({ driverPath: driver.driverPath, label: driver.label, view })),
      ),
    );
    if (!primary) {
      return false;
    }
    showPanel(
      model.buildDriverViewLink(serverUrl, primary.driverPath, primary.view, "none"),
      { client: ref.client, lease: ref.lease.name },
      `${primary.view.title}: ${primary.label}`,
      primary.view.icon,
    );
    return true;
  };

  const open = async (node: unknown, focused: boolean): Promise<void> => {
    const ref = leaseOf(node);
    if (!ref) {
      return;
    }
    try {
      const server = await serverFor(ref.client, ref.lease.name);
      if (!focused) {
        // The whole workbench wants a window of its own.
        await showInBrowser(model.buildWebUiLink(server.url));
        return;
      }
      const setting = vscode.workspace.getConfiguration("jumpstarter").get("webUi.tools");
      const tools = model.normalizeTools(setting, views);
      if (preferred() === "panel" && !Array.isArray(setting)) {
        if (await openPrimaryPanel(ref, server.url)) {
          return;
        }
      }
      if (preferred() === "browser") {
        await showInBrowser(model.buildWebUiLink(server.url, tools.length > 0 ? { tools, chrome: "minimal" } : {}));
        return;
      }
      showPanel(
        model.buildWebUiLink(server.url, { tools, chrome: "none" }),
        { client: ref.client, lease: ref.lease.name },
        ref.lease.exporter_name || ref.lease.name.slice(0, 8),
        "display",
      );
    } catch (err) {
      report(err);
    }
  };

  const openDriverView = async (node: unknown): Promise<void> => {
    const n = node as DriverNode | undefined;
    if (!n || n.kind !== "driver" || !n.descriptor) {
      void vscode.window.showInformationMessage("Select a driver of a lease in the Jumpstarter Leases view first.");
      return;
    }
    const available = model.viewsForDriver(n.descriptor.driverClass, n.descriptor.driverPath, views);
    if (available.length === 0) {
      void vscode.window.showInformationMessage(
        `Jumpstarter: no installed Jumpstarter Web plugin has a view for ${n.descriptor.description}.`,
      );
      return;
    }
    let view = available[0];
    if (available.length > 1) {
      const picked = await vscode.window.showQuickPick(
        available.map((v) => ({ label: v.title, description: v.id, view: v })),
        { title: `Open ${n.descriptor.label}`, placeHolder: "Which view?" },
      );
      if (!picked) {
        return;
      }
      view = picked.view;
    }
    try {
      const server = await serverFor(n.client, n.leaseName);
      if (preferred() === "browser") {
        await showInBrowser(model.buildDriverViewLink(server.url, n.descriptor.driverPath, view, "minimal"));
        return;
      }
      showPanel(
        model.buildDriverViewLink(server.url, n.descriptor.driverPath, view, "none"),
        { client: n.client, lease: n.leaseName },
        `${view.title}: ${n.descriptor.label}`,
        view.icon,
      );
    } catch (err) {
      report(err);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("jumpstarter.leases.openWebUi", (node: unknown) => open(node, true)),
    vscode.commands.registerCommand("jumpstarter.leases.openFullWebUi", (node: unknown) => open(node, false)),
    vscode.commands.registerCommand("jumpstarter.leases.openDriverView", openDriverView),
    vscode.commands.registerCommand("jumpstarter.webUi.stop", () => {
      const count = servers.size;
      stopAll();
      void vscode.window.showInformationMessage(
        count === 0 ? "Jumpstarter: no Web UI is running." : `Jumpstarter: stopped ${count} Web UI server(s).`,
      );
    }),
  );

  return {
    serverUrl: (leaseName) => servers.get(leaseName)?.url,
    stopAll,
    panelLinks: () => [...panels.keys()],
    panelHtml: (link) => panels.get(link)?.webview.html,
    closePanels: () => {
      for (const panel of [...panels.values()]) {
        panel.dispose();
      }
    },
    refreshViews,
  };
}
