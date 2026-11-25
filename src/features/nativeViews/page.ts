/**
 * The document of a native Jumpstarter view (no vscode imports).
 *
 * A view (a device's screen, an Appium Inspector) is the page of Jumpstarter
 * Web itself, loaded from its files into a webview and run without a server:
 * before the page's script runs, this document sets the global the page looks
 * for (`__JUMPSTARTER_HOST__`, docs/bridge.md of jumpstarter-web), which gives
 * it the lease's bridge for its API, the place of its files and of its
 * plugins', and the window's theme. The page's own deep link then narrows it
 * to one view with nothing around it.
 *
 * Nothing here is a frame: the page is the webview's own document, so there is
 * no origin to allow and no address to reach.
 */

import { HOST_TOKEN_SOURCES } from "../webUi/panel";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** JSON that can sit inside a `<script>`. */
function inline(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export interface HostedPage {
  /** `index.html` of Jumpstarter Web, as built. */
  index: string;
  /**
   * Where the webview loads the bridge's files from: a path the server would
   * serve under (`/`, `/plugins/hmi/`) and the address of its directory,
   * without a slash at its end.
   */
  files: Readonly<Record<string, string>>;
  /** The webview's own source for its policy (`webview.cspSource`). */
  cspSource: string;
  nonce: string;
  title: string;
  /** The page's route (`/d/display?view=...&chrome=none`), without the `#`. */
  route: string;
  /** What the API's paths are under: `/api/v1/roles/phone` for one role of a lease with members. */
  basePath?: string;
  /** What VS Code keeps with the panel, to make it again when the window is loaded again. */
  state?: unknown;
  /** The page reports what it shows on its way to its view (texts, alerts): for finding what flashes. */
  trace?: boolean;
}

/** The files as the page's `url()` looks them up: the longest path first. */
export function fileRoots(files: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(files)
    .map(([prefix, base]): [string, string] => [prefix.endsWith("/") ? prefix : `${prefix}/`, base.replace(/\/+$/, "")])
    .sort((a, b) => b[0].length - a[0].length);
}

/**
 * The page's own `index.html` with its files' addresses moved to where the
 * webview has them: `/assets/...` in an attribute or in the import map.
 */
export function moveIndex(index: string, root: string): string {
  return index.replace(/(["'])\/(assets\/)/g, (_, quote: string, rest: string) => `${quote}${root}/${rest}`);
}

/**
 * The script that runs before the page's: the page's host. It carries bridge
 * messages between the page and the extension (binary data as an ArrayBuffer,
 * which is what `postMessage` moves without copying it into text), says where
 * files are, and follows the window's theme.
 */
function hostScript(page: HostedPage): string {
  const config = inline({
    files: fileRoots(page.files),
    basePath: page.basePath ?? "",
    route: page.route,
    sources: HOST_TOKEN_SOURCES,
    state: page.state ?? null,
    trace: page.trace === true,
  });
  return `(function () {
  var config = ${config};
  var vscode = acquireVsCodeApi();
  if (config.state) { vscode.setState(config.state); }
  var listeners = [];
  window.addEventListener("message", function (event) {
    var message = event.data && event.data.bridge;
    if (!message) { return; }
    if (message.data instanceof ArrayBuffer) { message.data = new Uint8Array(message.data); }
    listeners.slice().forEach(function (listener) { listener(message); });
  });
  function theme() {
    var style = getComputedStyle(document.documentElement);
    var tokens = {};
    Object.keys(config.sources).forEach(function (token) {
      for (var i = 0; i < config.sources[token].length; i++) {
        var value = style.getPropertyValue(config.sources[token][i]).trim();
        if (value) { tokens[token] = value; break; }
      }
    });
    var kind = document.body ? document.body.classList : { contains: function () { return false; } };
    var light = kind.contains("vscode-light") || kind.contains("vscode-high-contrast-light");
    return { mode: light ? "light" : "dark", tokens: tokens };
  }
  function report(kind, text) { vscode.postMessage({ page: { kind: kind, text: String(text).slice(0, 2000) } }); }
  window.addEventListener("error", function (event) { report("error", event.message || event.error); });
  window.addEventListener("unhandledrejection", function (event) { report("error", event.reason && event.reason.message || event.reason); });
  document.addEventListener("securitypolicyviolation", function (event) {
    report("blocked", event.violatedDirective + " " + event.blockedURI);
  });
  // what the extension can know of a page it cannot look into: that it drew something, and that it shows a picture
  var told = {};
  var notice = new MutationObserver(function () {
    var root = document.getElementById("root");
    if (!told.rendered && root && root.childElementCount > 0) {
      told.rendered = true;
      report("rendered", document.title);
      // a moment later, what the page looks like against the window: its background is the editor's, or it is not
      setTimeout(function () {
        var probe = document.createElement("div");
        probe.style.cssText = "position:absolute;visibility:hidden;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)";
        document.body.appendChild(probe);
        var editor = getComputedStyle(probe);
        var colors = { editor: editor.backgroundColor, editorText: editor.color, surfaces: [] };
        probe.remove();
        // every surface from the page's root down to the view: the first that paints is what is seen
        for (var el = document.querySelector("canvas, video, [class*=placeholder]") || root.firstElementChild; el; el = el.parentElement) {
          var bg = getComputedStyle(el).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") { colors.surfaces.push((el.id || el.className || el.tagName).toString().slice(0, 120) + " " + bg); }
        }
        colors.text = getComputedStyle(root).color;
        colors.host = document.documentElement.getAttribute("data-host");
        report("theme", JSON.stringify(colors));
      }, 2500);
    }
    var picture = document.querySelector("canvas, video");
    if (!told.picture && picture) { told.picture = true; report("picture", picture.tagName.toLowerCase()); }
    if (told.rendered && told.picture) { notice.disconnect(); }
  });
  document.addEventListener("DOMContentLoaded", function () { notice.observe(document.body, { childList: true, subtree: true }); });
  // JUMPSTARTER_TRACE: what the page showed on its way to its view (its texts and alerts, as they came and went)
  if (config.trace) {
    var last = "";
    var started = Date.now();
    var sample = function () {
      var alerts = Array.prototype.map.call(document.querySelectorAll("[class*=c-alert]:not([class*=c-alert__])"), function (el) {
        return (/pf-m-(warning|danger|info|success)/.exec(el.className) || ["", "plain"])[1] + ": " + el.textContent.slice(0, 120);
      });
      var now = JSON.stringify({ text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 160), alerts: alerts, spinner: !!document.querySelector("[class*=c-spinner], [role=progressbar]") });
      if (now !== last) { last = now; report("trace", (Date.now() - started) + "ms " + now); }
      if (Date.now() - started < 30000) { requestAnimationFrame(sample); }
    };
    requestAnimationFrame(sample);
  }
  window.__JUMPSTARTER_HOST__ = {
    basePath: config.basePath,
    post: function (message) {
      if (message.data instanceof Uint8Array) {
        var bytes = message.data;
        message = Object.assign({}, message, { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      }
      vscode.postMessage({ bridge: message });
    },
    listen: function (listener) {
      listeners.push(listener);
      return function () { listeners = listeners.filter(function (l) { return l !== listener; }); };
    },
    url: function (path) {
      for (var i = 0; i < config.files.length; i++) {
        if (path.indexOf(config.files[i][0]) === 0) { return config.files[i][1] + "/" + path.slice(config.files[i][0].length); }
      }
      return path;
    },
    theme: function (listener) {
      var send = function () { listener(theme()); };
      // VS Code restyles a webview in place when the theme changes: its body's class, its root's variables.
      var observer = new MutationObserver(send);
      var watch = function () {
        send();
        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
      };
      if (document.body) { watch(); } else { document.addEventListener("DOMContentLoaded", watch); }
      return function () { observer.disconnect(); };
    }
  };
  // the page's route is in its address: one view, and nothing around it
  history.replaceState(null, "", "#" + config.route);
  // (said before the page draws anything: its own title bar is never seen on the way to a view with none)
  if (/[?&]chrome=none(&|$)/.test(config.route)) { document.documentElement.setAttribute("data-jw-chrome", "none"); }
})();`;
}

/**
 * The webview's document: Jumpstarter Web's own page, its files where the
 * webview has them, a policy that lets it load those and nothing else, and
 * the host's script before everything.
 */
export function buildHostedPageHtml(page: HostedPage): string {
  const root = fileRoots(page.files).find(([prefix]) => prefix === "/")?.[1];
  if (root === undefined) {
    throw new Error("the bridge did not say where the page's files are");
  }
  const source = page.cspSource;
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${page.nonce}' ${source}`,
    // (React sets styles on elements, and PatternFly's components do too)
    `style-src ${source} 'unsafe-inline'`,
    `font-src ${source}`,
    `img-src ${source} data: blob:`,
    "media-src blob: mediastream:",
    `connect-src ${source}`,
    "worker-src blob:",
  ].join("; ");
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">`,
    // (the editor's own background from the first paint, before the page has drawn anything on it)
    `<style nonce="${page.nonce}">html, body, #root { height: 100%; } html, body { background: var(--vscode-editor-background); } body { margin: 0; padding: 0; }</style>`,
    `<script nonce="${page.nonce}">${hostScript(page)}</script>`,
  ].join("\n    ");
  let html = moveIndex(page.index, root)
    .replace(/<script type="importmap">/g, `<script type="importmap" nonce="${page.nonce}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(page.title)}</title>`);
  if (!/<head>/.test(html)) {
    throw new Error("the page of Jumpstarter Web has no <head>");
  }
  html = html.replace("<head>", `<head>\n    ${head}`);
  return html;
}

/** The route of a link built by ../webUi/model (what follows its `#`). */
export function routeOf(link: string): string {
  const at = link.indexOf("#");
  return at < 0 ? "/" : link.slice(at + 1);
}

/**
 * A tab while its view is on its way: a spinner in the middle, in the window's own colours, and nothing to read.
 * What it waits for is said to a screen reader.
 */
export function buildProgressHtml(nonce: string, label: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'">
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); }
  body { display: flex; align-items: center; justify-content: center; }
  .spinner {
    width: 28px; height: 28px; border-radius: 50%; box-sizing: border-box;
    border: 3px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
    border-top-color: var(--vscode-progressBar-background, var(--vscode-foreground));
    animation: turn 0.9s linear infinite;
  }
  @keyframes turn { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
</style>
</head>
<body><div class="spinner" role="progressbar" aria-busy="true" aria-label="${escapeHtml(label)}"></div></body>
</html>`;
}
