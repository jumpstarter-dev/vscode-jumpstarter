/**
 * Unit tests for the pure Web UI logic (src/features/webUi/model.ts).
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildDriverViewLink,
  buildMemberLeaseLink,
  buildRoleCommand,
  buildServeArgs,
  buildWebUiLink,
  DEFAULT_TOOLS,
  normalizeFrameOrigins,
  parseEndpoints,
  linkFor,
  normalizeTools,
  panelState,
  parsePanelState,
  portTaken,
  panelIconName,
  primaryView,
  originOf,
  parsePluginViews,
  parseReadyUrl,
  resolveWebCommand,
  ROLE_SESSION_SCRIPT,
  serverKey,
  tail,
  viewsForDriver,
} from "../../features/webUi/model";
import { buildMessageHtml, buildPanelHtml, HOST_MESSAGE, HOST_TOKEN_SOURCES } from "../../features/webUi/panel";

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
  // unset, with the installed plugins known: the ones that have a centre view to show
  assert.deepEqual(normalizeTools(null, parsePluginViews(LISTING)), ["hmi", "serial"]);
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
      views: [{ id: "hmi/screen", type: "main", kind: "display", icon: "display", title: "Screen", matches: [HMI] }],
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
        { id: "serial/console", type: "main", kind: "terminal", title: "Serial", matches: ["s.PySerialClient"] },
        { id: "serial/labelled", type: "main", title: "Serial", matches: ["n.NetworkClient"], labels: { a: "b" } },
      ],
    },
    { id: "old", compatible: false, views: [{ id: "old/view", type: "main", title: "Old", matches: [HMI] }] },
    { id: "odd", compatible: true, views: [{ id: "odd/a b", type: "main" }, null, { type: "main" }] },
  ],
});

test("only the main views of loadable plugins are offered", () => {
  assert.deepEqual(parsePluginViews(LISTING), [
    { id: "hmi/screen", plugin: "hmi", title: "Screen", matches: [HMI], icon: "display", kind: "display" },
    // a terminal view is left to VS Code's own terminals; one that does not say its kind is taken as it is
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

test("a panel's tab has the icon of its view, or a plain one", () => {
  assert.equal(panelIconName("display"), "display");
  assert.equal(panelIconName("tools"), "tools");
  assert.equal(panelIconName("plug"), "view");
  assert.equal(panelIconName(undefined), "view");
});

test("a driver's link opens that driver and that view of it alone", () => {
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

test("a workspace's endpoints come from the setting, or from its environment", () => {
  assert.deepEqual(parseEndpoints({ "7071": "https://ws-1.che.example/", "x": "https://no", "7072": "ftp://no" }, undefined), [
    { port: 7071, url: "https://ws-1.che.example" },
  ]);
  assert.deepEqual(parseEndpoints({}, "7071=https://a.example, 7072=https://b.example/path,bad,99999=https://c"), [
    { port: 7071, url: "https://a.example" },
    { port: 7072, url: "https://b.example" },
  ]);
  assert.deepEqual(parseEndpoints(undefined, undefined), []);
});

test("on an endpoint the server listens beyond loopback, at the endpoint's address, with its token", () => {
  assert.deepEqual(
    buildServeArgs({ port: 7071, host: "0.0.0.0", publicUrl: "https://ws-1.che.example", frameOrigins: ["https://che.example"] }),
    ["serve", "--host", "0.0.0.0", "--port", "7071", "--public-url", "https://ws-1.che.example", "--auth", "token",
      "--allowed-frame-origin", "https://che.example"],
  );
});

test("a workspace's environment says what frames its panels, when the setting does not", () => {
  assert.deepEqual(normalizeFrameOrigins(null, "https://che.example"), ["https://che.example"]);
  assert.deepEqual(normalizeFrameOrigins(["vscode-webview:"], "https://che.example"), ["vscode-webview:"]);
  assert.deepEqual(normalizeFrameOrigins(undefined, ""), ["vscode-webview:", "vscode-file:"]);
});

test("a lease opens with its display, or with its first tool where it has none", () => {
  const tool = { id: "appium-inspector/inspector", plugin: "appium-inspector", title: "Appium", matches: [], kind: "tool" as const };
  const screen = { id: "hmi/screen", plugin: "hmi", title: "Screen", matches: [], kind: "display" as const };
  const appium = { driverPath: ["android", "appium"], label: "appium", view: tool };
  const hmi = { driverPath: ["cuttlefish", "hmi"], label: "hmi", view: screen };
  assert.equal(primaryView([appium, hmi]), hmi);
  assert.equal(primaryView([appium]), appium);
  assert.equal(primaryView([]), undefined);
});

test("a panel keeps what it is, without the server's address or token, and is made again from it", () => {
  const link = "https://ws-1.che.example/?token=secret#/d/cuttlefish/hmi?view=hmi%2Fscreen%23cuttlefish%2Fhmi&only=hmi&chrome=none";
  const state = panelState("homelab", "lease-1", link, "Screen: hmi", "display");
  assert.deepEqual(state, {
    client: "homelab",
    lease: "lease-1",
    route: "#/d/cuttlefish/hmi?view=hmi%2Fscreen%23cuttlefish%2Fhmi&only=hmi&chrome=none",
    title: "Screen: hmi",
    icon: "display",
  });
  assert.ok(!JSON.stringify(state).includes("secret"));
  // the same view on whatever server the lease has when the window is loaded again
  assert.equal(
    linkFor("https://ws-2.che.example/?token=other", state.route),
    "https://ws-2.che.example/?token=other#/d/cuttlefish/hmi?view=hmi%2Fscreen%23cuttlefish%2Fhmi&only=hmi&chrome=none",
  );
  assert.deepEqual(parsePanelState(JSON.parse(JSON.stringify(state))), state);
});

test("a kept state that is not one is not trusted", () => {
  assert.equal(parsePanelState(undefined), undefined);
  assert.equal(parsePanelState({ client: "c", lease: "l", title: "t", route: "javascript:alert(1)" }), undefined);
  assert.equal(parsePanelState({ client: "c", lease: 3, title: "t", route: "#/d/" }), undefined);
});

test("the panel's document hands its state to VS Code, and a message panel frames nothing", () => {
  const html = buildPanelHtml({
    link: "http://127.0.0.1:1/#/d/",
    nonce: "n",
    title: "Screen",
    state: { client: "c", lease: "l", route: "#/d/", title: "Screen" },
  });
  assert.ok(html.includes("acquireVsCodeApi().setState(config.state)"));
  assert.ok(html.includes('"lease":"l"'));
  const message = buildMessageHtml("n", "Opening <Screen> again…");
  assert.ok(!message.includes("<iframe") && !message.includes("<script"));
  assert.ok(!message.includes("<Screen>"));
});

test("a server that could not have its port says so in a way that is recognized", () => {
  assert.ok(portTaken("Jumpstarter Web exited (1) before it listened.\nOSError: [Errno 98] Address already in use"));
  assert.ok(portTaken("error while attempting to bind on address ('0.0.0.0', 7071): address already in use"));
  assert.ok(!portTaken("Jumpstarter Web is not installed in this environment."));
});

// ---------------------------------------------------------------------------
// A lease with members: one view with all its roles, and a role's own views
// ---------------------------------------------------------------------------

test("a lease with members opens as one view, with the window that shows its other roles", () => {
  const server = "http://127.0.0.1:7071/";
  // What the link names to show also names the roles beside the first: without it the page shows one role.
  assert.equal(
    buildMemberLeaseLink(server, { tools: ["hmi", "appium-inspector"], chrome: "none" }),
    "http://127.0.0.1:7071/#/d/?only=hmi,appium-inspector,shell%2Fcompanions&chrome=none",
  );
  assert.equal(
    buildMemberLeaseLink(server, { tools: ["hmi", "shell/companions"], chrome: "minimal" }),
    "http://127.0.0.1:7071/#/d/?only=hmi,shell%2Fcompanions&chrome=minimal",
  );
  // The whole workbench has every window already.
  assert.equal(buildMemberLeaseLink(server), "http://127.0.0.1:7071/#/d/");
  assert.equal(buildMemberLeaseLink(server, { tools: [], chrome: "none" }), "http://127.0.0.1:7071/#/d/?chrome=none");
  // (the token of a server that has one stays in the query, never in the route)
  assert.equal(
    buildMemberLeaseLink("https://ws.example/?token=t", { tools: ["hmi"], chrome: "none" }),
    "https://ws.example/?token=t#/d/?only=hmi,shell%2Fcompanions&chrome=none",
  );
});

test("a role's view is served by a server started as that role, inside the lease's shell", () => {
  const serve = ["/venv/bin/jumpstarter-web", "serve", "--host", "127.0.0.1", "--port", "7071"];
  assert.deepEqual(buildRoleCommand("/venv/bin/python", "phone", serve), [
    "/venv/bin/python", "-c", ROLE_SESSION_SCRIPT, "phone", ...serve,
  ]);
  // It gives the command the role's exporter the way `jmp shell` gives a lease of one exporter its own.
  assert.match(ROLE_SESSION_SCRIPT, /JMP_LEASE_MEMBERS/);
  assert.match(ROLE_SESSION_SCRIPT, /os\.environ\['JUMPSTARTER_HOST'\] = entry\['socket'\]/);
  assert.match(ROLE_SESSION_SCRIPT, /os\.execvp\(sys\.argv\[2\], sys\.argv\[2:\]\)/);
});

test("a lease and each of its roles have a server of their own", () => {
  assert.equal(serverKey("lease-1"), "lease-1");
  assert.notEqual(serverKey("lease-1", "phone"), serverKey("lease-1"));
  assert.notEqual(serverKey("lease-1", "phone"), serverKey("lease-1", "headunit"));
  // (a lease's name cannot contain what separates it from the role)
  assert.notEqual(serverKey("a", "b-c"), serverKey("a-b", "c"));
});

test("a panel of a role's view keeps the role, and is made again on that role's server", () => {
  const link = "http://127.0.0.1:7071/#/d/hmi?view=hmi%2Fscreen%23hmi&only=hmi&chrome=none";
  const state = panelState("lab", "lease-9m2qd", link, "Screen: phone hmi", "display", "phone");
  assert.deepEqual(state, {
    client: "lab",
    lease: "lease-9m2qd",
    role: "phone",
    route: "#/d/hmi?view=hmi%2Fscreen%23hmi&only=hmi&chrome=none",
    title: "Screen: phone hmi",
    icon: "display",
  });
  assert.deepEqual(parsePanelState(JSON.parse(JSON.stringify(state))), state);
  // A lease's own panel has no role; one that is not a role's name is not taken for one.
  assert.equal("role" in panelState("lab", "lease-1", link, "Screen"), false);
  assert.equal(parsePanelState({ ...state, role: "../etc" })?.role, undefined);
  assert.equal(parsePanelState({ ...state, role: 7 })?.role, undefined);
});
