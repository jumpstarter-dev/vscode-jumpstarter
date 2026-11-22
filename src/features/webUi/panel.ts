/**
 * The document of a Jumpstarter Web panel (no vscode imports).
 *
 * A view of Jumpstarter Web is shown in a webview, in a frame, so that it can
 * look like the rest of the window: a webview is the one place VS Code's theme
 * is readable (as `--vscode-*` variables), and this document passes it on to
 * the page in the frame. The page takes it over `postMessage`
 * (`jumpstarter.host/1`) and only from what its server was told may frame it
 * (`--allowed-frame-origin`).
 */

/** The protocol the page and what frames it speak. */
export const HOST_MESSAGE = "jumpstarter.host/1";

/**
 * The page's host tokens, and the VS Code variables each is read from: the
 * first that has a value wins.
 */
export const HOST_TOKEN_SOURCES: Readonly<Record<string, readonly string[]>> = {
  "--jw-host-background": ["--vscode-editor-background"],
  "--jw-host-surface": ["--vscode-sideBar-background", "--vscode-editorWidget-background"],
  "--jw-host-foreground": ["--vscode-foreground", "--vscode-editor-foreground"],
  "--jw-host-muted": ["--vscode-descriptionForeground"],
  "--jw-host-border": ["--vscode-panel-border", "--vscode-editorGroup-border", "--vscode-widget-border"],
  "--jw-host-accent": ["--vscode-button-background"],
  "--jw-host-accent-foreground": ["--vscode-button-foreground"],
  "--jw-host-accent-hover": ["--vscode-button-hoverBackground"],
  "--jw-host-control-background": ["--vscode-input-background"],
  "--jw-host-control-border": ["--vscode-input-border", "--vscode-button-border", "--vscode-contrastBorder"],
  "--jw-host-hover-background": ["--vscode-list-hoverBackground", "--vscode-toolbar-hoverBackground"],
  "--jw-host-focus": ["--vscode-focusBorder"],
  "--jw-host-link": ["--vscode-textLink-foreground"],
  "--jw-host-font-family": ["--vscode-font-family"],
  "--jw-host-font-size": ["--vscode-font-size"],
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface PanelDocument {
  /** The page to frame (a link built by ./model). */
  link: string;
  /** For the document's own script and style, which nothing else may be. */
  nonce: string;
  /** What a screen reader calls the frame. */
  title: string;
  /**
   * What the panel is, for VS Code to keep with it: a window that is loaded again (a browser reload, a restart)
   * gives it back, and the panel is made again from it.
   */
  state?: unknown;
}

/**
 * The webview's document: one frame, filling the panel, and the script that
 * tells the framed page the window's theme — when the frame loads, when the
 * page says it is ready, and whenever the theme changes.
 */
export function buildPanelHtml({ link, nonce, title, state }: PanelDocument): string {
  const origin = new URL(link).origin;
  const config = JSON.stringify({ origin, type: HOST_MESSAGE, sources: HOST_TOKEN_SOURCES, state }).replace(
    /</g,
    "\\u003c",
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeHtml(origin)}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe id="view" title="${escapeHtml(title)}" src="${escapeHtml(link)}" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<script nonce="${nonce}">
(function () {
  var config = ${config};
  var frame = document.getElementById("view");
  // kept by VS Code with the panel, and handed to the extension when the window is loaded again
  if (config.state && typeof acquireVsCodeApi === "function") {
    acquireVsCodeApi().setState(config.state);
  }
  function theme() {
    var style = getComputedStyle(document.documentElement);
    var tokens = {};
    Object.keys(config.sources).forEach(function (token) {
      for (var i = 0; i < config.sources[token].length; i++) {
        var value = style.getPropertyValue(config.sources[token][i]).trim();
        if (value) { tokens[token] = value; break; }
      }
    });
    var kind = document.body.classList;
    var light = kind.contains("vscode-light") || kind.contains("vscode-high-contrast-light");
    return { mode: light ? "light" : "dark", tokens: tokens };
  }
  function send() {
    if (frame.contentWindow) {
      frame.contentWindow.postMessage({ type: config.type, theme: theme() }, config.origin);
    }
  }
  frame.addEventListener("load", send);
  window.addEventListener("message", function (event) {
    if (event.origin === config.origin && event.data && event.data.type === config.type && event.data.ready) {
      send();
    }
  });
  // VS Code restyles a webview in place when the theme changes: its body's class, its root's variables.
  var observer = new MutationObserver(send);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
})();
</script>
</body>
</html>`;
}

/** A panel with a sentence in it and no frame: what is shown while its view is found again, or cannot be. */
export function buildMessageHtml(nonce: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'">
<style nonce="${nonce}">
  body { margin: 0; padding: 16px; color: var(--vscode-descriptionForeground); font: var(--vscode-font-size) var(--vscode-font-family); }
</style>
</head>
<body>${escapeHtml(message)}</body>
</html>`;
}
