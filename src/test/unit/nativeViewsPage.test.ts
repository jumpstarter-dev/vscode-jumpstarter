/** The document of a native view: Jumpstarter Web's page, its files moved, its host set before it runs. */

import test from "node:test";
import assert from "node:assert/strict";
import { buildHostedPageHtml, buildProgressHtml, fileRoots, moveIndex, routeOf } from "../../features/nativeViews/page";
import { bridgeCommand, withBundle } from "../../services/leaseBridge";

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <title>Jumpstarter Web</title>
    <script type="importmap">{"imports":{"react":"/assets/react.js"}}</script>
    <script type="module" crossorigin src="/assets/index.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

const PAGE = {
  index: INDEX,
  files: { "/": "https://files.test/static/", "/plugins/hmi/": "https://files.test/hmi/ui" },
  cspSource: "https://files.test",
  nonce: "n0nce",
  title: "Screen: <phone>",
  route: "/d/display?view=hmi%2Fscreen%23display&only=hmi&chrome=none",
  basePath: "/api/v1/roles/phone",
  state: { v: 1, lease: "lease-1" },
};

test("the page's files are moved to where the webview has them, in attributes and in the import map", () => {
  const moved = moveIndex(INDEX, "https://files.test/static");
  assert.ok(moved.includes(`"react":"https://files.test/static/assets/react.js"`));
  assert.ok(moved.includes(`src="https://files.test/static/assets/index.js"`));
  assert.ok(moved.includes(`href="https://files.test/static/assets/index.css"`));
  assert.ok(!/["']\/assets\//.test(moved));
});

test("a file is looked up under the longest path that has it", () => {
  assert.deepEqual(fileRoots(PAGE.files), [
    ["/plugins/hmi/", "https://files.test/hmi/ui"],
    ["/", "https://files.test/static"],
  ]);
});

test("the document sets the page's host before the page's script, and lets it load its files and nothing else", () => {
  const html = buildHostedPageHtml(PAGE);
  const host = html.indexOf("window.__JUMPSTARTER_HOST__");
  assert.ok(host > 0 && host < html.indexOf("assets/index.js"), "the host is set first");
  assert.ok(html.includes(`<script type="importmap" nonce="n0nce">`));
  assert.ok(html.includes(`"basePath":"/api/v1/roles/phone"`));
  assert.ok(html.includes(`"route":"/d/display?view=hmi%2Fscreen%23display&only=hmi&chrome=none"`));
  assert.ok(html.includes("<title>Screen: &#60;phone&#62;</title>"));
  const policy = /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.ok(policy.includes("default-src &#39;none&#39;"));
  assert.ok(policy.includes("script-src &#39;nonce-n0nce&#39; https://files.test"));
  // no frame and no address to call: the view's data comes over postMessage
  assert.ok(!policy.includes("frame-src"));
  assert.ok(!/connect-src[^;]*(http:|ws:|\*)/.test(policy));
  assert.ok(!html.includes("<iframe"));
});

test("a state cannot end the script it is written into", () => {
  const html = buildHostedPageHtml({ ...PAGE, state: { title: "</script><script>alert(1)</script>" } });
  assert.ok(!html.includes("</script><script>alert(1)"));
});

test("a bridge that did not say where its page is cannot be shown", () => {
  assert.throws(() => buildHostedPageHtml({ ...PAGE, files: {} }), /where the page's files are/);
});

test("the route of a link is what follows its #", () => {
  assert.equal(routeOf("http://view.invalid/#/d/power?view=a&chrome=none"), "/d/power?view=a&chrome=none");
  assert.equal(routeOf("http://view.invalid/"), "/");
});

test("the bridge runs with the lease's own interpreter, and the extension's copy first on its path", () => {
  assert.deepEqual(bridgeCommand("/venv/bin/python"), ["/venv/bin/python", "-m", "jumpstarter_web", "bridge"]);
  assert.equal(withBundle("/ext/python", undefined), "/ext/python");
  assert.match(withBundle("/ext/python", "/mine") ?? "", /^\/ext\/python[:;]\/mine$/);
  assert.equal(withBundle(undefined, "/mine"), "/mine");
});

test("a tab that is opening shows a spinner in the window's colours, and no sentence", () => {
  const html = buildProgressHtml("n0nce", "Opening Screen: <phone>");
  assert.ok(html.includes(`role="progressbar"`));
  assert.ok(html.includes(`aria-label="Opening Screen: &#60;phone&#62;"`));
  assert.ok(html.includes("background: var(--vscode-editor-background)"));
  assert.equal(/<body>(.*)<\/body>/s.exec(html)?.[1].replace(/<[^>]*>/g, "").trim(), "");
});
