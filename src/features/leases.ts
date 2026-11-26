/**
 * Leases feature — view id jumpstarter.leases.
 *
 * - Polls `jmp get leases` for the active client (auth-guarded via
 *   ensureAuthValid; polling stops on auth-expired and a re-authenticate
 *   message node is shown instead).
 * - Live remaining-time countdown between polls (local timer, no jmp calls).
 * - Per-lease actions: open shell, run current file, extend, end lease,
 *   copy JMP_LEASE export line.
 * - In-Use leases expand into a cached driver tree (drivers + runnable `j`
 *   commands); command leaves run inside the lease session in a terminal.
 * - A lease with members (from a lease template) expands into its roles and
 *   forwards; a bound role expands into its own drivers, whose commands run
 *   as `j ROLE DRIVER ...` in the one session of the lease. Shell, extend and
 *   end act on the lease as a whole.
 */

import * as vscode from "vscode";
import * as path from "path";
import { Services, JmpError, waitForRelease } from "../services";
import { RELEASE_WAIT_MS } from "../services/pendingLeasesModel";
import { shellQuote } from "../services/jmpProtocol";
import { CliParam, Lease } from "../types";
import { showDetails } from "./details";
import * as model from "./leases/model";
import {
  LeasesTreeProvider,
  LeaseNode,
  CommandNode,
} from "./leases/provider";

/** Local countdown re-render cadence (no jmp calls involved). */
const COUNTDOWN_TICK_MS = 10_000;

/** How long to keep the progress bar up waiting for a lease change to land. */
const SETTLE_TIMEOUT_MS = 30_000;
const SETTLE_POLL_MS = 1_000;

export function registerLeases(
  context: vscode.ExtensionContext,
  services: Services,
): LeasesTreeProvider {
  const { jmp } = services;
  const provider = new LeasesTreeProvider(jmp, services.pendingLeases);
  context.subscriptions.push(provider);
  // A request going out or settling changes what this view shows right now,
  // without waiting for the next poll.
  context.subscriptions.push(services.pendingLeases.onDidChange(() => provider.refresh()));

  const treeView = vscode.window.createTreeView("jumpstarter.leases", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => {
      const selected = e.selection[0] as { kind?: string; lease?: Lease } | undefined;
      // (a role or a forward is part of its lease: the lease is what the pane describes)
      if (selected?.lease && ["lease", "role", "forward"].includes(selected.kind ?? "")) {
        showDetails({ kind: "lease", lease: selected.lease });
      }
    }),
  );

  let includeEnded = false;
  let lastClient: string | null = null;

  // -- polling --------------------------------------------------------------

  const poller = services.createPoller({
    name: "leases",
    tick: async () => {
      const clients = await jmp.listClients();
      const current = clients.currentConfig;
      if (!current) {
        lastClient = null;
        provider.setNoClient();
        treeView.description = "";
        return;
      }
      lastClient = current;
      // Never let a background call hit an expired token (it would start an
      // interactive browser re-auth and hang).
      await jmp.ensureAuthValid(current);
      const leases = await jmp.getLeases(current, includeEnded);
      provider.setLeases(current, leases);
      treeView.description = model.viewDescription(current, includeEnded);
      treeView.message = undefined;
      // The direction of a forward is its ports', which the exporters declare:
      // asked only when a lease has forwards, and never a reason to fail.
      if (leases.some((lease) => (lease.forwards ?? []).length > 0)) {
        provider.setExporterPorts(await jmp.getExporterPorts(current));
      }
    },
  });
  context.subscriptions.push(poller);

  context.subscriptions.push(
    poller.onTickError((err) => {
      if (err instanceof JmpError && err.kind === "auth-expired") {
        // Stop polling this client entirely until the user retries.
        poller.stop();
        provider.setAuthExpired(lastClient ?? "current");
        treeView.message = undefined;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const shown = provider.setError(message);
      if (!shown) {
        // Stale data is still displayed; surface the failure above the tree.
        treeView.message = `Last refresh failed: ${message}`;
      }
      services.jmp.log(`[leases] refresh failed: ${message}`);
    }),
  );

  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => poller.setVisible(e.visible)),
  );

  // External `jmp login` / `jmp config client use` / new configs: restart
  // polling (it may have been stopped by auth-expired) and refresh.
  const restart = (): void => {
    if (!poller.running) {
      poller.start();
    } else {
      void poller.refreshNow();
    }
  };
  context.subscriptions.push(
    services.configWatcher.onDidChangeConfig(restart),
    jmp.onDidChangeAvailability(() => {
      provider.refreshDrivers();
      restart();
    }),
    // A lease acquired from the Exporters view belongs here immediately.
    // (and its status settles over the next seconds: Waiting, then In-Use)
    services.onDidChangeLeases(() => void poller.watch()),
  );

  // Live remaining-time countdown between polls; pure re-render.
  const countdown = setInterval(() => {
    if (treeView.visible && provider.hasTickingLeases()) {
      provider.refreshCountdowns();
    }
  }, COUNTDOWN_TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(countdown) });

  poller.start();

  // -- helpers --------------------------------------------------------------

  const requireLeaseNode = (node: unknown): LeaseNode | undefined => {
    if (
      node &&
      typeof node === "object" &&
      (node as LeaseNode).kind === "lease" &&
      (node as LeaseNode).lease
    ) {
      return node as LeaseNode;
    }
    void vscode.window.showInformationMessage(
      "Select a lease in the Jumpstarter Leases view first.",
    );
    return undefined;
  };

  const openLeaseTerminal = async (
    terminalName: string,
    getShell: () => Promise<{ command: string; args: string[] }>,
  ): Promise<void> => {
    try {
      const shell = await getShell();
      jmp.log(`terminal "${terminalName}": ${shellQuote([shell.command, ...shell.args])}`);
      const terminal = vscode.window.createTerminal({
        name: terminalName,
        shellPath: shell.command,
        shellArgs: shell.args,
        env: await jmp.getTerminalEnv(),
      });
      terminal.show();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Jumpstarter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Run a one-shot command in the lease by typing it into a normal terminal.
   *
   * Launching it as the terminal's own process would close the terminal the
   * moment the command exits, taking its output with it; sending the line to
   * a shell leaves the output on screen and the shell ready for another run.
   */
  const runInLeaseTerminal = async (
    terminalName: string,
    getShell: () => Promise<{ command: string; args: string[] }>,
  ): Promise<void> => {
    try {
      const shell = await getShell();
      const line = shellQuote([shell.command, ...shell.args]);
      jmp.log(`terminal "${terminalName}": ${line}`);
      const terminal = vscode.window.createTerminal({
        name: terminalName,
        env: await jmp.getTerminalEnv(),
      });
      terminal.show();
      terminal.sendText(line);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Jumpstarter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Guard for user-initiated remote jmp calls (extend/end): an expired
   * token would otherwise send the no-TTY background process into an
   * interactive browser re-auth that hangs until the timeout. Returns true
   * when the call may proceed.
   */
  const checkAuth = async (client: string): Promise<boolean> => {
    try {
      await jmp.ensureAuthValid(client);
      return true;
    } catch (err) {
      if (err instanceof JmpError && err.kind === "auth-expired") {
        void vscode.window.showWarningMessage(
          `Jumpstarter: client '${client}' needs re-authentication first (re-authenticate from the Clients view or run \`jmp login\` in a terminal).`,
        );
        return false;
      }
      showJmpError("Failed to check authentication", err);
      return false;
    }
  };

  /**
   * Run a lease mutation with the Leases view showing progress until the
   * change is actually visible, not merely requested: the CLI returns as soon
   * as the controller accepts the lease, while binding, provisioning and
   * recycling all happen afterwards.
   */
  const withLeaseProgress = async <T>(
    title: string,
    work: () => Promise<T>,
    settled?: (leases: readonly import("../types").Lease[]) => boolean,
  ): Promise<T | undefined> => {
    return vscode.window.withProgress(
      { location: { viewId: "jumpstarter.leases" }, title },
      async () => {
        let result: T;
        try {
          result = await work();
        } catch (err) {
          showJmpError(title, err);
          return undefined;
        }
        services.notifyLeasesChanged();
        if (settled && lastClient) {
          await waitFor(lastClient, settled);
        }
        void poller.refreshNow();
        return result;
      },
    );
  };

  /** Poll until the predicate holds, or give up so the bar never hangs. */
  const waitFor = async (
    client: string,
    settled: (leases: readonly import("../types").Lease[]) => boolean,
  ): Promise<void> => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if (settled(await jmp.getLeases(client, true))) {
          return;
        }
      } catch {
        return; // The view's own error handling reports it on the next tick.
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  };

  const showJmpError = (prefix: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`${prefix}: ${message}`);
  };

  /** Ask for one parameter, using the driver's own help text. */
  const askForParam = async (
    command: model.CommandDescriptor,
    param: CliParam,
  ): Promise<model.ParamValue | undefined> => {
    const title = `${command.label} — ${model.describeParam(param)}`;
    const help = param.help?.trim();

    if (param.is_flag) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: "Yes", description: `pass ${model.optionFlag(param)}`, value: true },
          { label: "No", description: "leave it out", value: false },
        ],
        { title, placeHolder: help ?? "Include this flag?" },
      );
      return picked?.value;
    }

    if (param.choices && param.choices.length > 0) {
      const picked = await vscode.window.showQuickPick(param.choices, {
        title,
        placeHolder: help ?? "Choose a value",
      });
      return picked;
    }

    const value = await vscode.window.showInputBox({
      title,
      prompt: help,
      placeHolder: param.required ? "required" : "leave empty to skip",
      value: param.default !== null && param.default !== undefined ? String(param.default) : "",
      ignoreFocusOut: true,
      validateInput: (input) => {
        if (param.required && input.trim().length === 0) {
          return `${param.name} is required`;
        }
        if (input.trim().length > 0 && param.type === "integer" && !/^-?\d+$/.test(input.trim())) {
          return `${param.name} must be a whole number`;
        }
        return undefined;
      },
    });
    return value === undefined ? undefined : value.trim();
  };

  /**
   * Collect values for a command's parameters. Required ones are asked for in
   * order; optional ones are offered as a multi-select first, so a command
   * with none runs straight away. Returns undefined when the user cancels.
   */
  const collectParamValues = async (
    command: model.CommandDescriptor,
  ): Promise<Map<string, model.ParamValue> | undefined> => {
    const { required, optional } = model.promptableParams(command);
    const values = new Map<string, model.ParamValue>();

    for (const param of required) {
      const value = await askForParam(command, param);
      if (value === undefined) {
        return undefined;
      }
      values.set(param.name, value);
    }

    if (optional.length > 0) {
      const picked = await vscode.window.showQuickPick(
        optional.map((param) => ({
          label: model.describeParam(param),
          description: param.help?.trim(),
          param,
        })),
        {
          title: `${command.label} — optional parameters`,
          placeHolder: "Select any to set, or press Enter to run without them",
          canPickMany: true,
        },
      );
      if (picked === undefined) {
        return undefined;
      }
      for (const { param } of picked) {
        const value = await askForParam(command, param);
        if (value === undefined) {
          return undefined;
        }
        values.set(param.name, value);
      }
    }

    return values;
  };

  // -- commands -------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand("jumpstarter.leases.refresh", () => {
      jmp.forgetSharedReads(); // asked for by hand: read everything again
      poller.start();
      return poller.refreshNow();
    }),

    vscode.commands.registerCommand("jumpstarter.leases.toggleEnded", () => {
      includeEnded = !includeEnded;
      // Always re-read: the user just changed what they are asking to see, and
      // start() only ticks of its own accord while the view is visible — so a
      // toggle on a stopped poller would otherwise show the old list.
      poller.start();
      return poller.refreshNow();
    }),

    vscode.commands.registerCommand("jumpstarter.leases.openShell", async (node: unknown) => {
      const leaseNode = requireLeaseNode(node);
      if (!leaseNode) {
        return;
      }
      await openLeaseTerminal(`jmp shell ${model.shortLeaseName(leaseNode.lease.name)}`, () =>
        jmp.getShellCommand(leaseNode.client, leaseNode.lease.name),
      );
    }),

    vscode.commands.registerCommand(
      "jumpstarter.leases.runCurrentFile",
      async (node: unknown) => {
        const leaseNode = requireLeaseNode(node);
        if (!leaseNode) {
          return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== "file") {
          void vscode.window.showInformationMessage(
            "Open a file in the editor to run it in the lease.",
          );
          return;
        }
        if (editor.document.isDirty && !(await editor.document.save())) {
          return;
        }
        const filePath = editor.document.uri.fsPath;
        await runInLeaseTerminal(`jmp run ${path.basename(filePath)}`, () =>
          jmp.getRunFileCommand(leaseNode.client, leaseNode.lease.name, filePath),
        );
      },
    ),

    vscode.commands.registerCommand("jumpstarter.leases.extend", async (node: unknown) => {
      const leaseNode = requireLeaseNode(node);
      if (!leaseNode) {
        return;
      }
      const custom = "Custom…";
      const picked = await vscode.window.showQuickPick(
        [...model.EXTEND_DURATION_CHOICES, custom],
        {
          title: `Set duration of lease ${model.shortLeaseName(leaseNode.lease.name)}`,
          placeHolder: "New total lease duration (measured from its start)",
        },
      );
      if (!picked) {
        return;
      }
      let duration = picked;
      if (picked === custom) {
        const input = await vscode.window.showInputBox({
          title: "Custom lease duration",
          placeHolder: "e.g. 45m, 1h30m, 2h",
          validateInput: (v) =>
            model.isValidDuration(v) ? undefined : "Use a duration like 30m, 1h or 1h30m",
        });
        if (!input) {
          return;
        }
        duration = input.trim();
      }
      if (!(await checkAuth(leaseNode.client))) {
        return;
      }
      await withLeaseProgress(`Extending lease ${model.shortLeaseName(leaseNode.lease.name)}…`, () =>
        jmp.updateLease(leaseNode.client, leaseNode.lease.name, duration),
      );
    }),

    vscode.commands.registerCommand("jumpstarter.leases.end", async (node: unknown) => {
      const leaseNode = requireLeaseNode(node);
      if (!leaseNode) {
        return;
      }
      const lease = leaseNode.lease;
      // (a lease with members is ended as one: every role goes back)
      const target = model.describeLeaseHolding(lease);
      const confirmed = await vscode.window.showWarningMessage(
        `End lease '${lease.name}'${target}?`,
        { modal: true },
        "End Lease",
      );
      if (confirmed !== "End Lease") {
        return;
      }
      if (!(await checkAuth(leaseNode.client))) {
        return;
      }
      if (provider.isReleasing(lease.name)) {
        return; // (asked twice: the first is still going)
      }
      // The row says the lease is going from now until it is released, the
      // controller refuses, or the time allowed is over, whichever comes
      // first: `jmp delete leases` answers before the exporter is given back.
      provider.markReleasing(lease.name);
      try {
        await vscode.window.withProgress(
          { location: { viewId: "jumpstarter.leases" }, title: `Ending lease '${lease.name}'…` },
          async () => {
            try {
              await jmp.deleteLease(leaseNode.client, lease.name);
            } catch (err) {
              showJmpError("Failed to end lease", err);
              return;
            }
            const outcome = await waitForRelease(lease.name, {
              list: () => jmp.getLeases(leaseNode.client, false),
            });
            if (outcome === "timeout") {
              void vscode.window.showWarningMessage(
                `Jumpstarter: lease '${lease.name}' is still held ${Math.round(RELEASE_WAIT_MS / 1000)} seconds after it was ended.`,
              );
            }
            // The view reads the listing before the row stops saying "releasing":
            // it is then gone, not back as it was for a moment.
            await poller.refreshNow();
          },
        );
      } finally {
        provider.released(lease.name);
        // (the exporter it held is free again: the other views read too)
        services.notifyLeasesChanged();
      }
    }),

    vscode.commands.registerCommand("jumpstarter.leases.copyExport", async (node: unknown) => {
      const leaseNode = requireLeaseNode(node);
      if (!leaseNode) {
        return;
      }
      const line = model.buildExportLine(leaseNode.lease.name);
      await vscode.env.clipboard.writeText(line);
      void vscode.window.showInformationMessage(`Copied: ${line}`);
    }),

    vscode.commands.registerCommand(
      "jumpstarter.leases.refreshDevices",
      (node: unknown) => {
        // Invoked from the lease context menu (LeaseNode), from a role of a
        // lease with members (RoleNode) or from the inline driver-error
        // node's retry action ({ leaseName }).
        let leaseName: string | undefined;
        if (node && typeof node === "object") {
          const n = node as { kind?: string; lease?: { name?: string }; leaseName?: string };
          leaseName = n.kind === "lease" ? n.lease?.name : (n.leaseName ?? n.lease?.name);
        }
        if (leaseName) {
          provider.refreshDrivers(leaseName);
        }
      },
    ),

    vscode.commands.registerCommand(
      "jumpstarter.leases.runDeviceCommand",
      async (node: unknown) => {
        const n = node as CommandNode | undefined;
        if (!n || n.kind !== "command" || !n.descriptor) {
          return;
        }
        const values = await collectParamValues(n.descriptor);
        if (!values) {
          return; // cancelled
        }
        // (for a role of a lease with members the arguments start with the role: `j ROLE DRIVER ...`)
        const args = model.buildCommandArgs(n.descriptor, values);
        await runInLeaseTerminal(`j ${args.join(" ")}`, () =>
          jmp.getShellCommand(n.client, n.leaseName, ["j", ...args]),
        );
      },
    ),
  );

  return provider;
}
