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
  normalizeTools,
  originOf,
  parsePluginViews,
  parseReadyUrl,
  resolveWebCommand,
  tail,
  viewsForDriver,
} from "../../features/webUi/model";

test("the server's address is read from its ready line, among other output", () => {
  const output = "INFO attaching to lease\njumpstarter-web: http://127.0.0.1:8123/\nINFO serving\n";
  assert.equal(parseReadyUrl(output), "http://127.0.0.1:8123/");
  assert.equal(parseReadyUrl("jumpstarter-web API: http://127.0.0.1:1/api/v1/"), undefined);
  assert.equal(parseReadyUrl("starting…"), undefined);
});

test("the focused link narrows the page and hides its navigation", () => {
  assert.equal(
    buildWebUiLink("http://127.0.0.1:8123/", { tools: ["hmi", "appium-inspector"], minimal: true }),
    "http://127.0.0.1:8123/#/d/?only=hmi,appium-inspector&chrome=minimal",
  );
});

test("the full link opens the device with nothing narrowed", () => {
  assert.equal(buildWebUiLink("http://127.0.0.1:8123/"), "http://127.0.0.1:8123/#/d/");
});

test("a token stays in the query and never reaches the hash", () => {
  const link = buildWebUiLink("https://ws.example/?token=abc", { tools: ["hmi"], minimal: true });
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
