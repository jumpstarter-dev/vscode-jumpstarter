/**
 * Leases feature — view id jumpstarter.leases.
 *
 * - Polls `jmp get leases` for the active client (auth-guarded via
 *   ensureAuthValid; polling stops on auth-expired and a re-authenticate
 *   message node is shown instead).
 * - Live remaining-time countdown between polls (local timer, no jmp calls).
 * - Per-lease actions: open shell, run current file, extend, release,
 *   copy JMP_LEASE export line.
 * - In-Use leases expand into a cached device tree (drivers + runnable `j`
 *   commands); command leaves run inside the lease session in a terminal.
 */

import * as vscode from "vscode";
import * as path from "path";
import { Services, JmpError } from "../services";
import { Lease } from "../types";
import { showDetails } from "./details";
import * as model from "./leases/model";
import {
  LeasesTreeProvider,
  LeaseNode,
  CommandNode,
} from "./leases/provider";

/** Local countdown re-render cadence (no jmp calls involved). */
const COUNTDOWN_TICK_MS = 10_000;

export function registerLeases(context: vscode.ExtensionContext, services: Services): void {
  const { jmp } = services;
  const provider = new LeasesTreeProvider(jmp);
  context.subscriptions.push(provider);

  const treeView = vscode.window.createTreeView("jumpstarter.leases", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => {
      const selected = e.selection[0] as { kind?: string; lease?: Lease } | undefined;
      if (selected?.kind === "lease" && selected.lease) {
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
      services.output.appendLine(`[leases] refresh failed: ${message}`);
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
    jmp.onDidChangeAvailability(() => restart()),
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
      const terminal = vscode.window.createTerminal({
        name: terminalName,
        shellPath: shell.command,
        shellArgs: shell.args,
      });
      terminal.show();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Jumpstarter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Guard for user-initiated remote jmp calls (extend/release): an expired
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

  const showJmpError = (prefix: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`${prefix}: ${message}`);
  };

  // -- commands -------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand("jumpstarter.leases.refresh", () => {
      if (!poller.running) {
        poller.start();
      } else {
        void poller.refreshNow();
      }
    }),

    vscode.commands.registerCommand("jumpstarter.leases.toggleEnded", () => {
      includeEnded = !includeEnded;
      if (!poller.running) {
        poller.start();
      } else {
        void poller.refreshNow();
      }
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
        await openLeaseTerminal(`jmp run ${path.basename(filePath)}`, () =>
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
      try {
        await jmp.updateLease(leaseNode.client, leaseNode.lease.name, duration);
        void poller.refreshNow();
      } catch (err) {
        showJmpError("Failed to update lease", err);
      }
    }),

    vscode.commands.registerCommand("jumpstarter.leases.release", async (node: unknown) => {
      const leaseNode = requireLeaseNode(node);
      if (!leaseNode) {
        return;
      }
      const lease = leaseNode.lease;
      const target = lease.exporter_name ? ` on exporter '${lease.exporter_name}'` : "";
      const confirmed = await vscode.window.showWarningMessage(
        `Release lease '${lease.name}'${target}?`,
        { modal: true },
        "Release",
      );
      if (confirmed !== "Release") {
        return;
      }
      if (!(await checkAuth(leaseNode.client))) {
        return;
      }
      try {
        await jmp.deleteLease(leaseNode.client, lease.name);
        void poller.refreshNow();
      } catch (err) {
        showJmpError("Failed to release lease", err);
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
        // Invoked from the lease context menu (LeaseNode) or from the inline
        // device-error node's retry action ({ leaseName }).
        let leaseName: string | undefined;
        if (node && typeof node === "object") {
          const n = node as { kind?: string; lease?: { name?: string }; leaseName?: string };
          leaseName = n.kind === "lease" ? n.lease?.name : n.leaseName;
        }
        if (leaseName) {
          provider.refreshDevices(leaseName);
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
        await openLeaseTerminal(n.descriptor.label, () =>
          jmp.getShellCommand(n.client, n.leaseName, ["j", ...n.descriptor.cliPath]),
        );
      },
    ),
  );
}
