/**
 * Unit tests for the pure Web UI logic (src/features/webUi/model.ts).
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildDriverViewLink,
  buildServeArgs,
  buildWebUiLink,
  DEFAULT_TOOLS,
  normalizeFrameOrigins,
  normalizeTools,
  originOf,
  parsePluginViews,
  parseReadyUrl,
  resolveWebCommand,
  tail,
  viewsForDriver,
} from "../../features/webUi/model";
import { buildPanelHtml, HOST_MESSAGE, HOST_TOKEN_SOURCES } from "../../features/webUi/panel";

test("the server's address is read from its ready line, among other output", () => {
  const output = "INFO attaching to lease\njumpstarter-web: http://127.0.0.1:8123/\nINFO serving\n";
  assert.equal(parseReadyUrl(output), "http://127.0.0.1:8123/");
  assert.equal(parseReadyUrl("jumpstarter-web API: http://127.0.0.1:1/api/v1/"), undefined);
  assert.equal(parseReadyUrl("starting…"), undefined);
});

test("the focused link narrows the page and hides its navigation", () => {
  assert.equal(
    buildWebUiLink("http://127.0.0.1:8123/", { tools: ["hmi", "appium-inspector"], chrome: "minimal" }),
    "http://127.0.0.1:8123/#/d/?only=hmi,appium-inspector&chrome=minimal",
  );
});

test("the full link opens the device with nothing narrowed", () => {
  assert.equal(buildWebUiLink("http://127.0.0.1:8123/"), "http://127.0.0.1:8123/#/d/");
});

test("a token stays in the query and never reaches the hash", () => {
  const link = buildWebUiLink("https://ws.example/?token=abc", { tools: ["hmi"], chrome: "minimal" });
  assert.equal(link, "https://ws.example/?token=abc#/d/?only=hmi&chrome=minimal");
});

test("an instance entry keeps its path, encoded", () => {
  assert.equal(
    buildWebUiLink("http://127.0.0.1:1/", { tools: ["serial/console#uart"] }),
    "http://127.0.0.1:1/#/d/?only=serial%2Fconsole%23uart",
  );
});

test("the tools setting is cleaned before it is used", () => {
  assert.deepEqual(normalizeTools(undefined), [...DEFAULT_TOOLS]);
  assert.deepEqual(normalizeTools([" hmi ", "hmi", "@display", "bad entry", "a&b=c", 7]), ["hmi", "@display"]);
  assert.deepEqual(normalizeTools([]), []);
});

test("serve listens on loopback", () => {
  assert.deepEqual(buildServeArgs({ port: 8123 }), ["serve", "--host", "127.0.0.1", "--port", "8123"]);
});

test("serve is told what may frame the page", () => {
  const args = buildServeArgs({ port: 8123, frameOrigins: ["vscode-webview:", "https://che.example"] });
  assert.deepEqual(args.slice(-4), [
    "--allowed-frame-origin", "vscode-webview:", "--allowed-frame-origin", "https://che.example",
  ]);
});

test("the frame origins setting is cleaned; unset, it is a desktop window's panels", () => {
  assert.deepEqual(normalizeFrameOrigins(undefined), ["vscode-webview:", "vscode-file:"]);
  assert.deepEqual(normalizeFrameOrigins([]), []);
  assert.deepEqual(
    normalizeFrameOrigins(["VSCode-Webview:", "https://che.example", "*", "https://a.example/path", "x y", 3]),
    ["vscode-webview:", "https://che.example"],
  );
});

test("a panel's link shows the views alone", () => {
  const [view] = parsePluginViews(LISTING);
  assert.match(buildDriverViewLink("http://127.0.0.1:1/", ["hmi"], view, "none"), /&chrome=none$/);
  assert.equal(
    buildWebUiLink("http://127.0.0.1:1/", { tools: ["hmi"], chrome: "none" }),
    "http://127.0.0.1:1/#/d/?only=hmi&chrome=none",
  );
});

test("the panel's document frames the link and nothing else, and knows whom to tell the theme", () => {
  const link = "http://127.0.0.1:8123/#/d/hmi?view=hmi%2Fscreen%23hmi&only=hmi&chrome=none";
  const html = buildPanelHtml({ link, nonce: "abc123", title: 'Screen: "hmi" <1>' });
  // only this server may be framed, only this document's own script and style run
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:8123; script-src 'nonce-abc123'; style-src 'nonce-abc123'/);
  assert.ok(html.includes('src="http://127.0.0.1:8123/#/d/hmi?view=hmi%2Fscreen%23hmi&#38;only=hmi&#38;chrome=none"'));
  assert.ok(html.includes('"origin":"http://127.0.0.1:8123"'));
  assert.ok(html.includes(HOST_MESSAGE));
  // the title is text, never markup
  assert.ok(!html.includes('<1>'));
  // every token the page knows has somewhere to come from
  assert.ok(Object.keys(HOST_TOKEN_SOURCES).every((token) => token.startsWith("--jw-host-")));
  assert.ok(html.includes("--vscode-editor-background"));
});

const HMI = "jumpstarter_driver_hmi.client.HmiClient";
const LISTING = JSON.stringify({
  plugins: [
    {
      id: "hmi",
      compatible: true,
      views: [{ id: "hmi/screen", type: "main", title: "Screen", matches: [HMI] }],
    },
    {
      id: "power",
      compatible: true,
      views: [{ id: "power/panel", type: "sidebar", title: "Power", matches: ["p.PowerClient"] }],
    },
    {
      id: "serial",
      compatible: true,
      views: [
        { id: "serial/network-console", type: "main", title: "Serial", matches: ["n.NetworkClient"], names: ["console"] },
        { id: "serial/labelled", type: "main", title: "Serial", matches: ["n.NetworkClient"], labels: { a: "b" } },
      ],
    },
    { id: "old", compatible: false, views: [{ id: "old/view", type: "main", title: "Old", matches: [HMI] }] },
    { id: "odd", compatible: true, views: [{ id: "odd/a b", type: "main" }, null, { type: "main" }] },
  ],
});

test("only the main views of loadable plugins are offered", () => {
  assert.deepEqual(parsePluginViews(LISTING), [
    { id: "hmi/screen", plugin: "hmi", title: "Screen", matches: [HMI] },
    // one whose condition cannot be checked from here (labels) is left out
    { id: "serial/network-console", plugin: "serial", title: "Serial", matches: ["n.NetworkClient"], names: ["console"] },
  ]);
});

test("output that is not a plugin listing offers nothing", () => {
  assert.deepEqual(parsePluginViews("Usage: jumpstarter-web [OPTIONS]"), []);
  assert.deepEqual(parsePluginViews("{}"), []);
  assert.deepEqual(parsePluginViews('{"plugins": 3}'), []);
});

test("a driver's views are the ones that match its client class", () => {
  const views = parsePluginViews(LISTING);
  assert.equal(viewsForDriver(HMI, ["cuttlefish", "hmi"], views).length, 1);
  assert.deepEqual(viewsForDriver("p.PowerClient", ["power"], views), []);
});

test("a view for drivers of certain names is not every driver's of that class", () => {
  const views = parsePluginViews(LISTING);
  assert.equal(viewsForDriver("n.NetworkClient", ["board", "console"], views).length, 1);
  assert.deepEqual(viewsForDriver("n.NetworkClient", ["cuttlefish", "turn"], views), []);
});

test("a driver's link opens that driver, that view, and its plugin alone", () => {
  const [view] = parsePluginViews(LISTING);
  assert.equal(
    buildDriverViewLink("http://127.0.0.1:8123/", ["cuttlefish", "hmi"], view),
    "http://127.0.0.1:8123/#/d/cuttlefish/hmi?view=hmi%2Fscreen%23cuttlefish%2Fhmi&only=hmi&chrome=minimal",
  );
});

test("behind a forwarded address serve is told it, and asks for its token", () => {
  const args = buildServeArgs({ port: 8123, publicUrl: "https://ws-8123.che.example" });
  assert.deepEqual(args.slice(-4), ["--public-url", "https://ws-8123.che.example", "--auth", "token"]);
});

test("jumpstarter-web comes from the environment jmp runs from", () => {
  const never = (): boolean => false;
  assert.deepEqual(resolveWebCommand({ command: "/venv/bin/python", prefixArgs: ["-m", "jumpstarter_cli"] }, "", never), [
    "/venv/bin/python", "-m", "jumpstarter_web",
  ]);
  assert.deepEqual(
    resolveWebCommand({ command: "/venv/bin/jmp", prefixArgs: [] }, "", (f) => f === "/venv/bin/jumpstarter-web"),
    ["/venv/bin/jumpstarter-web"],
  );
  assert.deepEqual(resolveWebCommand({ command: "/venv/bin/jmp", prefixArgs: [] }, "", never), ["jumpstarter-web"]);
  assert.deepEqual(resolveWebCommand({ command: "/venv/bin/jmp", prefixArgs: [] }, " /opt/jw ", never), ["/opt/jw"]);
});

test("origins and tails", () => {
  assert.equal(originOf("https://ws.example:8443/path?x=1"), "https://ws.example:8443");
  assert.equal(tail("a\nb\nc\n", 2), "b\nc");
});
