/**
 * Native views: a view of a lease (a device's screen, an Appium Inspector) as
 * a tab of VS Code's own, with no server behind it.
 *
 * Each view is one webview panel: the phone's screen and the head unit's are
 * two tabs, placed, split and closed like any editor. What is in a tab is the
 * view's content, loaded from the files of Jumpstarter Web (./nativeViews/page.ts);
 * what it shows and does goes through the lease's bridge
 * (../services/leaseBridge.ts), over `postMessage`. Nothing listens anywhere,
 * so there is no port to forward and no address for a workspace in the browser
 * to map.
 */

import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { readFile } from "fs/promises";
import * as path from "path";
import { Services } from "../services";
import type { LeaseBridges } from "../services/leaseBridge";
import type { BridgeIncoming, BridgeOutgoing, BridgePort } from "../vendor/jumpstarter-api/bridge";
import { buildHostedPageHtml, buildProgressHtml, routeOf } from "./nativeViews/page";
import { buildMessageHtml } from "./webUi/panel";
import * as model from "./webUi/model";

/** The type of a native view's panel: what VS Code restores them by. */
export const NATIVE_PANEL_TYPE = "jumpstarter.view";

/** One view of one driver of a lease (or of one role of a lease with members). */
export interface NativeViewRequest {
  client: string;
  lease: string;
  role?: string;
  driverPath: readonly string[];
  view: model.WebView;
  title: string;
}

/** What VS Code keeps with a panel, to make it again in a window that is loaded again. */
interface KeptView extends NativeViewRequest {
  v: 1;
}

export interface NativeViews {
  /** The extension's own copy of Jumpstarter Web (a directory for PYTHONPATH), when it carries one. */
  readonly bundle: string | undefined;
  /** Show the view in a tab of its own; asking again brings that tab forward. */
  open(request: NativeViewRequest): Promise<void>;
  /** The open views, as `lease|role|driver/path|view id`, oldest first. */
  keys(): string[];
  /** The document of an open view. */
  html(key: string): string | undefined;
  closeAll(): void;
  /**
   * What an open view's page reported of itself (it drew, it shows a picture, an error, something its policy
   * blocked) and what went between it and the bridge: the only look there is into a webview.
   */
  diagnostics(key: string): ViewDiagnostics | undefined;
  /** Ends the bridges of this window, and with them their views; how many bridges there were. */
  stopBridges(): number;
}

export interface ViewDiagnostics {
  notes: { kind: string; text: string }[];
  /** Messages the page sent the bridge, by operation, and the bridge the page, by event. */
  sent: Record<string, number>;
  received: Record<string, number>;
  /** Bytes of binary data the bridge sent the page (a display's pictures). */
  bytesReceived: number;
}

export function viewKey(request: NativeViewRequest): string {
  return [request.lease, request.role ?? "", request.driverPath.join("/"), request.view.id].join("|");
}

function parseKept(value: unknown): KeptView | undefined {
  const kept = value as Partial<KeptView> | undefined;
  if (
    !kept ||
    kept.v !== 1 ||
    typeof kept.client !== "string" ||
    typeof kept.lease !== "string" ||
    typeof kept.title !== "string" ||
    !Array.isArray(kept.driverPath) ||
    !kept.driverPath.every((segment) => typeof segment === "string") ||
    typeof kept.view !== "object" ||
    kept.view === null ||
    typeof kept.view.id !== "string" ||
    typeof kept.view.plugin !== "string" ||
    (kept.role !== undefined && typeof kept.role !== "string")
  ) {
    return undefined;
  }
  return kept as KeptView;
}

/** Binary data as the bridge's messages carry it, whatever `postMessage` made of it on the way. */
function asBytes(value: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
  }
  if (typeof value === "object" && value !== null && Array.isArray((value as { data?: unknown }).data)) {
    return Uint8Array.from((value as { data: number[] }).data); // a Buffer that went through JSON
  }
  return undefined;
}

export function registerNativeViews(
  context: vscode.ExtensionContext,
  services: Services,
  bridges: LeaseBridges,
): NativeViews {
  const { jmp } = services;
  const panels = new Map<string, vscode.WebviewPanel>();
  const ports = new Map<vscode.WebviewPanel, BridgePort>();
  const diagnostics = new WeakMap<vscode.WebviewPanel, ViewDiagnostics>();
  const diagnosticsOf = (panel: vscode.WebviewPanel): ViewDiagnostics => {
    let found = diagnostics.get(panel);
    if (!found) {
      found = { notes: [], sent: {}, received: {}, bytesReceived: 0 };
      diagnostics.set(panel, found);
    }
    return found;
  };

  const message = (panel: vscode.WebviewPanel, text: string): void => {
    panel.webview.html = buildMessageHtml(randomBytes(16).toString("hex"), text);
  };

  /** Connect a panel to the lease's bridge and put the view's page in it. */
  const fill = async (panel: vscode.WebviewPanel, request: NativeViewRequest): Promise<void> => {
    const key = viewKey(request);
    const { ready, port } = await bridges.open(request.client, request.lease);
    ports.get(panel)?.close();
    ports.set(panel, port);

    const files = ready.files ?? {};
    const pageDir = files["/"];
    if (!pageDir) {
      throw new Error("the lease's Jumpstarter Web has no page (its UI is not built)");
    }
    const index = await readFile(path.join(pageDir, "index.html"), "utf8");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: Object.values(files).map((dir) => vscode.Uri.file(dir)),
    };
    const name = model.panelIconName(request.view.icon);
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "icons", `view-${name}-light.svg`),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "icons", `view-${name}-dark.svg`),
    };

    // the bridge's messages for this view, and the view's for the bridge
    const seen = diagnosticsOf(panel);
    port.subscribe((incoming: BridgeIncoming) => {
      seen.received[incoming.event] = (seen.received[incoming.event] ?? 0) + 1;
      if (incoming.event === "binary") {
        seen.bytesReceived += incoming.data.byteLength;
      }
      const data = incoming.event === "binary" ? incoming.data.buffer : undefined;
      void panel.webview.postMessage({ bridge: data ? { ...incoming, data } : incoming });
    });
    const kept: KeptView = { v: 1, ...request, driverPath: [...request.driverPath] };
    panel.webview.html = buildHostedPageHtml({
      index,
      files: Object.fromEntries(
        Object.entries(files).map(([prefix, dir]) => [prefix, panel.webview.asWebviewUri(vscode.Uri.file(dir)).toString()]),
      ),
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      title: request.title,
      route: routeOf(model.buildDriverViewLink("http://view.invalid", request.driverPath, request.view, "none")),
      basePath: request.role ? `/api/v1/roles/${encodeURIComponent(request.role)}` : "",
      state: kept,
      trace: process.env.JUMPSTARTER_TRACE === "1",
    });
    panels.set(key, panel);
  };

  const wire = (panel: vscode.WebviewPanel, key: () => string | undefined): void => {
    panel.webview.onDidReceiveMessage((received: { bridge?: BridgeOutgoing; page?: { kind?: string; text?: string } }) => {
      if (received?.bridge) {
        const outgoing = received.bridge;
        const seen = diagnosticsOf(panel);
        seen.sent[outgoing.op] = (seen.sent[outgoing.op] ?? 0) + 1;
        if (outgoing.op === "binary") {
          const data = asBytes(outgoing.data);
          if (data) {
            ports.get(panel)?.send({ ...outgoing, data });
          }
          return;
        }
        ports.get(panel)?.send(outgoing);
      } else if (received?.page) {
        // what went wrong in the page (an error, something its policy blocked): the one place it can be read
        const note = { kind: received.page.kind ?? "note", text: received.page.text ?? "" };
        diagnosticsOf(panel).notes.push(note);
        if (note.kind === "error" || note.kind === "blocked") {
          jmp.log(`view ${panel.title}: ${note.kind}: ${note.text}`);
        }
      }
    });
    panel.onDidDispose(() => {
      ports.get(panel)?.close();
      ports.delete(panel);
      const mine = key();
      if (mine !== undefined && panels.get(mine) === panel) {
        panels.delete(mine);
      }
    });
  };

  const open = async (request: NativeViewRequest): Promise<void> => {
    const key = viewKey(request);
    const existing = panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      NATIVE_PANEL_TYPE,
      request.title,
      // beside the editor; views after the first are tabs of the same group, to be moved where they are wanted
      { viewColumn: [...panels.values()][0]?.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: false },
      // kept when hidden: the view holds a live stream, and a reload would start it again
      { enableScripts: true, retainContextWhenHidden: true },
    );
    wire(panel, () => key);
    panel.webview.html = buildProgressHtml(randomBytes(16).toString("hex"), `Opening ${request.title}`);
    panels.set(key, panel);
    try {
      await vscode.window.withProgress(
        { location: { viewId: "jumpstarter.leases" }, title: "Connecting to the lease…" },
        () => fill(panel, request),
      );
    } catch (err) {
      panel.dispose();
      throw err;
    }
  };

  context.subscriptions.push(
    // a bridge that ended (the lease did): its views have nothing behind them
    bridges.onEnded((_client, lease) => {
      for (const [key, panel] of [...panels]) {
        if (key.startsWith(`${lease}|`)) {
          panel.dispose();
        }
      }
    }),
    vscode.window.registerWebviewPanelSerializer(NATIVE_PANEL_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
        const kept = parseKept(state);
        if (!kept) {
          message(panel, "This Jumpstarter view cannot be opened again: open it from its lease.");
          return;
        }
        let key: string | undefined;
        wire(panel, () => key);
        panel.webview.html = buildProgressHtml(randomBytes(16).toString("hex"), `Opening ${kept.title} again`);
        try {
          await fill(panel, kept);
          key = viewKey(kept);
        } catch (err) {
          message(panel, `${kept.title} cannot be opened again: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }),
    {
      dispose: () => {
        for (const panel of [...panels.values()]) {
          panel.dispose();
        }
      },
    },
  );

  return {
    bundle: bridges.bundle,
    open,
    keys: () => [...panels.keys()],
    html: (key) => panels.get(key)?.webview.html,
    closeAll: () => {
      for (const panel of [...panels.values()]) {
        panel.dispose();
      }
    },
    diagnostics: (key) => {
      const panel = panels.get(key);
      return panel ? diagnosticsOf(panel) : undefined;
    },
    stopBridges: () => bridges.stopAll(),
  };
}
