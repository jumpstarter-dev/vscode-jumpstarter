/**
 * Shared setup for the integration tests.
 *
 * These run inside a real VS Code, against the real extension, with one thing
 * replaced: `jumpstarter.jmpPath` points at src/test/fixtures/fake-jmp.mjs, so
 * every CLI call returns known data and every call is recorded. That keeps the
 * tests hermetic — no cluster, no controller, no Python — while still
 * exercising activation, tree rendering, commands and error handling for real.
 *
 * The UI stubs work because tests share the extension host's `vscode` module
 * instance with the extension, so replacing `vscode.window.showQuickPick` here
 * replaces the one the extension calls.
 */

import * as assert from "assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { JumpstarterApi } from "../../extension";

export const EXTENSION_ID = "jumpstarter.vscode-jumpstarter";

/** Absolute path of the fake CLI, resolved from the compiled test's location. */
export function fakeJmpPath(): string {
  // out/test/integration/harness.js -> repo root
  const root = path.resolve(__dirname, "..", "..", "..");
  const fake = path.join(root, "src", "test", "fixtures", "fake-jmp.mjs");
  assert.ok(existsSync(fake), `fake jmp not found at ${fake}`);
  return fake;
}

/** Where the fake writes its invocation log for this run. */
let logFile: string | undefined;

/** The config tree the host was pointed at, never the developer's own. */
export function configHome(): string {
  const home = process.env.JMP_CLIENT_CONFIG_HOME;
  assert.ok(home, "JMP_CLIENT_CONFIG_HOME must be set by .vscode-test.mjs");
  assert.ok(
    !home.includes(`${path.sep}.config${path.sep}jumpstarter`),
    `refusing to run against a real config home: ${home}`,
  );
  return home;
}

/**
 * Activate the extension with the fake CLI in place.
 *
 * Safe to call from every test file: activation happens once per host, and the
 * settings are idempotent.
 */
export async function activateWithFakeCli(experimentalCliFeatures = true): Promise<JumpstarterApi> {
  if (!logFile) {
    // .vscode-test.mjs picks the path so the host has it from the start;
    // fall back to a temp file when a runner did not set one.
    logFile = process.env.JMP_FAKE_LOG ?? path.join(mkdtempSync(path.join(tmpdir(), "jmp-fake-")), "calls.log");
    writeFileSync(logFile, "");
    process.env.JMP_FAKE_LOG = logFile;
  }

  const config = vscode.workspace.getConfiguration("jumpstarter");
  await config.update("jmpPath", fakeJmpPath(), vscode.ConfigurationTarget.Global);
  await config.update("kubectlPath", path.join(path.dirname(fakeJmpPath()), "fake-kubectl.mjs"), vscode.ConfigurationTarget.Global);
  // Most suites exercise the full integration contract; compatibility tests
  // explicitly select the default, current-main mode.
  await config.update("experimentalCliFeatures", experimentalCliFeatures, vscode.ConfigurationTarget.Global);
  await config.update("experimentalDriverSchemas", experimentalCliFeatures, vscode.ConfigurationTarget.Global);
  // Poll rarely: the tests drive refreshes themselves, and a background tick
  // racing an assertion is the classic source of flakes here.
  await config.update("pollIntervalSeconds", 3600, vscode.ConfigurationTarget.Global);

  const extension = vscode.extensions.getExtension<JumpstarterApi>(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} is not installed in the test host`);
  const api = await extension.activate();
  // The CLI path changed after construction in the common case, so make the
  // service re-probe before anything reads a view.
  await vscode.commands.executeCommand("jumpstarter.refresh");
  return api;
}

/** Every argv the extension has passed to the CLI so far. */
export function cliCalls(): string[][] {
  if (!logFile || !existsSync(logFile)) {
    return [];
  }
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

/** Forget the recorded calls, so an assertion can speak about one action. */
export function clearCliCalls(): void {
  if (logFile) {
    writeFileSync(logFile, "");
  }
}

/** The recorded calls that begin with these tokens. */
export function callsMatching(...tokens: string[]): string[][] {
  return cliCalls().filter((argv) => tokens.every((token, i) => argv[i] === token));
}

/** Assert the CLI was asked to do something, and return that call. */
export function expectCall(...tokens: string[]): string[] {
  const matches = callsMatching(...tokens);
  assert.ok(
    matches.length > 0,
    `expected a CLI call starting with ${tokens.join(" ")}; saw:\n` +
      cliCalls()
        .map((argv) => `  ${argv.join(" ")}`)
        .join("\n"),
  );
  return matches[matches.length - 1];
}

/** Wait for a condition the extension reaches asynchronously. */
export async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Root rows of a tree, as the labels a user would read. */
export async function treeLabels(provider: vscode.TreeDataProvider<unknown>): Promise<string[]> {
  const nodes = (await provider.getChildren()) ?? [];
  const items = await Promise.all(nodes.map((node) => provider.getTreeItem(node)));
  return items.map(labelOf);
}

/** Rows under one node, by label. */
export async function childLabels(
  provider: vscode.TreeDataProvider<unknown>,
  parentLabel: string,
): Promise<string[]> {
  const nodes = (await provider.getChildren()) ?? [];
  for (const node of nodes) {
    const item = await provider.getTreeItem(node);
    if (labelOf(item) === parentLabel) {
      const children = (await provider.getChildren(node)) ?? [];
      const items = await Promise.all(children.map((child) => provider.getTreeItem(child)));
      return items.map(labelOf);
    }
  }
  assert.fail(`no row labelled '${parentLabel}'`);
}

/** One row's TreeItem, found by label. */
export async function findItem(
  provider: vscode.TreeDataProvider<unknown>,
  label: string,
): Promise<vscode.TreeItem> {
  const nodes = (await provider.getChildren()) ?? [];
  for (const node of nodes) {
    const item = await provider.getTreeItem(node);
    if (labelOf(item) === label) {
      return item;
    }
  }
  assert.fail(`no row labelled '${label}'`);
}

function labelOf(item: vscode.TreeItem): string {
  return typeof item.label === "string" ? item.label : (item.label?.label ?? "");
}

/** The codicon id of a row's icon, or undefined when it is a file icon. */
export function iconIdOf(item: vscode.TreeItem): string | undefined {
  return item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : undefined;
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/**
 * Run something that opens a terminal and return how it was opened.
 *
 * Several commands do their work by handing an argv to a terminal rather than
 * spawning it — a shell in a lease, a local exporter session — so the argv is
 * the only thing there is to assert on.
 */
export async function captureTerminal(
  run: () => Promise<unknown>,
  timeoutMs = 15_000,
): Promise<vscode.TerminalOptions> {
  let opened: vscode.Terminal | undefined;
  const subscription = vscode.window.onDidOpenTerminal((terminal) => {
    opened ??= terminal;
  });
  try {
    await run();
    await waitFor("a terminal to open", () => opened !== undefined, timeoutMs);
  } finally {
    subscription.dispose();
  }
  const options = opened!.creationOptions as vscode.TerminalOptions;
  // Terminals accumulate across a suite and each holds a process.
  opened!.dispose();
  return options;
}

/** The argv a terminal was launched with, as one string. */
export function terminalArgv(options: vscode.TerminalOptions): string {
  const args = Array.isArray(options.shellArgs)
    ? options.shellArgs
    : options.shellArgs
      ? [options.shellArgs]
      : [];
  return [options.shellPath ?? "", ...args].join(" ");
}

// ---------------------------------------------------------------------------
// UI stubs
// ---------------------------------------------------------------------------

export interface UiAnswers {
  /** Answers for showQuickPick, in order. A string matches an item's label. */
  quickPicks?: (string | undefined)[];
  /** Answers for showInputBox, in order. */
  inputs?: (string | undefined)[];
  /** Answers for the action buttons on info/warning messages, in order. */
  messages?: (string | undefined)[];
}

/**
 * Answer the extension's prompts with a script, so an interactive command can
 * be driven end to end. Returns a restore function; always call it.
 */
export function stubUi(answers: UiAnswers): () => void {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = {
    showQuickPick: window.showQuickPick,
    showInputBox: window.showInputBox,
    showInformationMessage: window.showInformationMessage,
    showWarningMessage: window.showWarningMessage,
  };

  const quickPicks = [...(answers.quickPicks ?? [])];
  const inputs = [...(answers.inputs ?? [])];
  const messages = [...(answers.messages ?? [])];

  window.showQuickPick = async (items: unknown, options?: vscode.QuickPickOptions) => {
    const resolved = (await items) as (vscode.QuickPickItem | string)[];
    if (quickPicks.length === 0) {
      return undefined;
    }
    const wanted = quickPicks.shift();
    if (wanted === undefined) {
      return undefined;
    }
    const matches = (item: vscode.QuickPickItem | string): boolean =>
      typeof item === "string" ? item === wanted : item.label.includes(wanted);
    // A multi-select pick expects an array back, not one item.
    return (options as { canPickMany?: boolean })?.canPickMany
      ? resolved.filter(matches)
      : resolved.find(matches);
  };

  window.showInputBox = async () => (inputs.length > 0 ? inputs.shift() : undefined);

  const answerMessage = async () => (messages.length > 0 ? messages.shift() : undefined);
  window.showInformationMessage = answerMessage;
  window.showWarningMessage = answerMessage;

  return () => {
    Object.assign(window, original);
  };
}
