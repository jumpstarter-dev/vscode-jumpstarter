/**
 * Clients feature — the "jumpstarter.clients" tree view plus auth flows.
 *
 *  - Tree rows come from `jmp config client list` with a per-row auth badge
 *    from `jmp auth status` (a local check, never interactive).
 *  - Refreshes via a Poller (paused while the view is hidden) and on
 *    ConfigWatcher events, so logins / `jmp config client use` performed in
 *    external terminals are picked up.
 *  - Actions: set current, open the client YAML, delete (with confirmation),
 *    re-authenticate (runs `jmp login --client <alias>` in a visible
 *    terminal so the browser/device flow can happen), refresh.
 *  - Add-client wizard (jumpstarter.addClient): OIDC login in a terminal, or
 *    token-based `jmp config client create ... --nointeractive`.
 *  - Refines the status bar item: clicking it opens the client QuickPick.
 *
 * Registered from extension.ts as registerClients(context, services).
 */

import * as vscode from "vscode";
import { JmpAvailability, Services } from "../services";
import { AuthStatus } from "../types";
import { showDetails } from "./details";
import {
  authBadge,
  buildClientCreateArgs,
  buildClientPickEntries,
  buildClientRows,
  buildLoginArgs,
  buildReauthArgs,
  ClientRow,
  needsReauth,
  rowContextValue,
  rowDescription,
  rowTooltipLines,
  validateAlias,
  validateLoginTarget,
  validateRequired,
} from "./clients/logic";

// ---------------------------------------------------------------------------
// Tree data
// ---------------------------------------------------------------------------

type ClientsState =
  | { kind: "loading" }
  | { kind: "unavailable"; availability: JmpAvailability }
  | { kind: "error"; message: string }
  | { kind: "ok"; rows: ClientRow[] };

type ClientNode =
  | { kind: "client"; row: ClientRow }
  | { kind: "message"; label: string; icon: string; command?: vscode.Command };

class ClientsTreeProvider implements vscode.TreeDataProvider<ClientNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private state: ClientsState = { kind: "loading" };

  constructor(private readonly services: Services) {}

  /** Latest successfully loaded rows (empty until the first ok load). */
  get rows(): readonly ClientRow[] {
    return this.state.kind === "ok" ? this.state.rows : [];
  }

  /** Re-fetch clients + auth statuses and repaint. Never throws. */
  async load(): Promise<void> {
    const jmp = this.services.jmp;
    const availability = jmp.getAvailability();
    if (availability && availability.kind !== "ok") {
      this.state = { kind: "unavailable", availability };
      this.changeEmitter.fire();
      return;
    }
    try {
      const list = await jmp.listClients();
      const auth = new Map<string, AuthStatus>();
      const authErrors = new Map<string, string>();
      const caps = availability?.kind === "ok" ? availability.capabilities : undefined;
      if (caps === undefined || caps.authStatus) {
        // `jmp auth status` is a local token inspection — safe for every
        // client, even ones with expired tokens (never interactive).
        await Promise.all(
          list.items.map(async (item) => {
            try {
              auth.set(item.alias, await jmp.authStatus(item.alias));
            } catch (err) {
              authErrors.set(item.alias, err instanceof Error ? err.message : String(err));
            }
          }),
        );
      }
      this.state = { kind: "ok", rows: buildClientRows(list, auth, authErrors) };
    } catch (err) {
      this.state = {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    this.changeEmitter.fire();
  }

  getTreeItem(node: ClientNode): vscode.TreeItem {
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = node.command;
      item.contextValue = "jumpstarterClientsMessage";
      return item;
    }
    const row = node.row;
    const badge = authBadge(row.auth?.status);
    const item = new vscode.TreeItem(row.alias, vscode.TreeItemCollapsibleState.None);
    item.id = `jumpstarter-client:${row.alias}`;
    item.description = rowDescription(row);
    item.iconPath = new vscode.ThemeIcon(
      badge.icon,
      badge.color ? new vscode.ThemeColor(badge.color) : undefined,
    );
    item.tooltip = new vscode.MarkdownString(rowTooltipLines(row).join("\n\n"));
    item.contextValue = rowContextValue(row);
    return item;
  }

  getChildren(node?: ClientNode): ClientNode[] {
    if (node) {
      return [];
    }
    switch (this.state.kind) {
      case "loading":
        return [{ kind: "message", label: "Loading clients…", icon: "loading~spin" }];
      case "unavailable":
        return [
          {
            kind: "message",
            label: unavailableLabel(this.state.availability),
            icon: "warning",
            command: { command: "jumpstarter.refresh", title: "Retry" },
          },
        ];
      case "error":
        return [
          {
            kind: "message",
            label: `Failed to list clients: ${this.state.message}`,
            icon: "error",
            command: { command: "jumpstarter.clients.refresh", title: "Retry" },
          },
        ];
      case "ok":
        if (this.state.rows.length === 0) {
          return [
            {
              kind: "message",
              label: "No clients configured — add one…",
              icon: "add",
              command: { command: "jumpstarter.addClient", title: "Add Client" },
            },
          ];
        }
        return this.state.rows.map((row) => ({ kind: "client", row }));
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function unavailableLabel(availability: JmpAvailability): string {
  switch (availability.kind) {
    case "no-python":
      return "No active Python interpreter — select one, then retry";
    case "no-jmp-in-env":
      return "jumpstarter-cli is not installed in the active Python environment";
    case "error":
      return `jmp is not working: ${availability.error.message}`;
    case "ok":
      return "jmp is available";
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerClients(context: vscode.ExtensionContext, services: Services): void {
  const provider = new ClientsTreeProvider(services);
  const treeView = vscode.window.createTreeView("jumpstarter.clients", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => {
      const selected = e.selection[0];
      if (selected?.kind === "client") {
        showDetails({ kind: "client", client: selected.row });
      }
    }),
  );
  const poller = services.createPoller({
    name: "clients",
    tick: async () => {
      await provider.load();
      // Keep the status bar auth badge live too: a token can expire between
      // explicit refreshes while VS Code stays open. Coalescing overlapping
      // calls is handled inside StatusBarManager.refresh().
      void services.statusBar.refresh();
    },
  });
  context.subscriptions.push(provider, treeView, poller);

  poller.setVisible(treeView.visible);
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => poller.setVisible(e.visible)),
    services.configWatcher.onDidChangeConfig(() => void poller.refreshNow()),
    services.jmp.onDidChangeAvailability(() => void poller.refreshNow()),
    poller.onTickError((err) => {
      services.output.appendLine(`[clients] refresh failed: ${String(err)}`);
    }),
  );
  poller.start();

  // Status bar refinement: clicking the item opens the client QuickPick.
  services.statusBar.item.command = "jumpstarter.pickClient";

  const afterMutation = async (): Promise<void> => {
    await Promise.all([poller.refreshNow(), services.statusBar.refresh()]);
  };

  /**
   * Resolve the client a command targets: tree item arg or a plain alias
   * string (as passed by other features, e.g. the exporters view's
   * re-authenticate row), else QuickPick.
   */
  const resolveClient = async (
    node: ClientNode | string | undefined,
    placeHolder: string,
  ): Promise<ClientRow | undefined> => {
    if (node && typeof node === "object" && node.kind === "client") {
      return node.row;
    }
    let rows = provider.rows;
    if (rows.length === 0) {
      await provider.load();
      rows = provider.rows;
    }
    if (typeof node === "string") {
      const match = rows.find((r) => r.alias === node);
      if (match) {
        return match;
      }
    }
    if (rows.length === 0) {
      void vscode.window.showInformationMessage(
        "No Jumpstarter clients are configured. Use \"Jumpstarter: Add Client\" to create one.",
      );
      return undefined;
    }
    const entries = buildClientPickEntries(rows);
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({ ...e })),
      { placeHolder },
    );
    return picked ? rows.find((r) => r.alias === picked.alias) : undefined;
  };

  const showError = (action: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`${action}: ${message}`);
  };

  /** Open a visible terminal running `jmp <args...>` (interactive flows). */
  const runInTerminal = async (name: string, args: string[]): Promise<void> => {
    const invocation = await services.jmp.getInvocation();
    const terminal = vscode.window.createTerminal({
      name,
      shellPath: invocation.command,
      shellArgs: [...invocation.prefixArgs, ...args],
    });
    context.subscriptions.push(terminal);
    terminal.show();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("jumpstarter.clients.refresh", () => poller.refreshNow()),

    // The filled star shown on the current client's row. It marks the row
    // rather than acting on it; pressing it just says so.
    vscode.commands.registerCommand("jumpstarter.currentClient", (node?: ClientNode) => {
      const alias = node?.kind === "client" ? node.row.alias : undefined;
      void vscode.window.showInformationMessage(
        alias
          ? `'${alias}' is already the current Jumpstarter client.`
          : "This is the current Jumpstarter client.",
      );
    }),

    vscode.commands.registerCommand(
      "jumpstarter.useClient",
      async (node?: ClientNode) => {
        const row = await resolveClient(node, "Set the current Jumpstarter client");
        if (!row || row.isCurrent) {
          return;
        }
        try {
          await services.jmp.useClient(row.alias);
          await afterMutation();
        } catch (err) {
          showError(`Failed to set current client to '${row.alias}'`, err);
        }
      },
    ),

    vscode.commands.registerCommand(
      "jumpstarter.openClientConfig",
      async (node?: ClientNode) => {
        const row = await resolveClient(node, "Open a client configuration file");
        if (!row) {
          return;
        }
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(row.path));
        } catch (err) {
          showError(`Failed to open ${row.path}`, err);
        }
      },
    ),

    vscode.commands.registerCommand(
      "jumpstarter.deleteClient",
      async (node?: ClientNode) => {
        const row = await resolveClient(node, "Delete a client configuration");
        if (!row) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete Jumpstarter client '${row.alias}'?`,
          {
            modal: true,
            detail: `This deletes ${row.path} (including its stored credentials). Leases are not affected.`,
          },
          "Delete",
        );
        if (confirm !== "Delete") {
          return;
        }
        try {
          await services.jmp.deleteClientConfig(row.alias);
          await afterMutation();
        } catch (err) {
          showError(`Failed to delete client '${row.alias}'`, err);
        }
      },
    ),

    vscode.commands.registerCommand(
      "jumpstarter.reauthenticateClient",
      async (node?: ClientNode | string) => {
        const row = await resolveClient(node, "Re-authenticate a client");
        if (!row) {
          return;
        }
        try {
          await runInTerminal(`jmp login (${row.alias})`, buildReauthArgs(row.alias));
          void vscode.window.showInformationMessage(
            `Complete the login for '${row.alias}' in the terminal (a browser window may open). The view refreshes automatically.`,
          );
        } catch (err) {
          showError(`Failed to start login for '${row.alias}'`, err);
        }
      },
    ),

    vscode.commands.registerCommand("jumpstarter.pickClient", async () => {
      let rows = provider.rows;
      if (rows.length === 0) {
        await provider.load();
        rows = provider.rows;
      }
      const ADD = "$(add) Add a new client…";
      const entries = buildClientPickEntries(rows);
      const picked = await vscode.window.showQuickPick(
        [...entries.map((e) => ({ ...e })), { label: ADD, alias: undefined, description: "" }],
        { placeHolder: "Switch the current Jumpstarter client" },
      );
      if (!picked) {
        return;
      }
      if (picked.label === ADD) {
        await vscode.commands.executeCommand("jumpstarter.addClient");
        return;
      }
      const row = rows.find((r) => r.alias === picked.alias);
      if (!row) {
        return;
      }
      if (needsReauth(row.auth?.status)) {
        const choice = await vscode.window.showWarningMessage(
          `Client '${row.alias}' needs re-authentication (${authBadge(row.auth?.status).label}).`,
          "Re-authenticate",
          "Use Anyway",
        );
        if (choice === undefined) {
          return;
        }
        if (choice === "Re-authenticate") {
          await vscode.commands.executeCommand("jumpstarter.reauthenticateClient", {
            kind: "client",
            row,
          } satisfies ClientNode);
          return;
        }
      }
      if (!row.isCurrent) {
        try {
          await services.jmp.useClient(row.alias);
          await afterMutation();
        } catch (err) {
          showError(`Failed to set current client to '${row.alias}'`, err);
        }
      }
    }),

    vscode.commands.registerCommand("jumpstarter.addClient", async () => {
      const OIDC = "$(globe) Log in with OIDC";
      const TOKEN = "$(key) API token";
      const method = await vscode.window.showQuickPick(
        [
          {
            label: OIDC,
            detail: "Browser-based login against a Jumpstarter endpoint (jmp login)",
          },
          {
            label: TOKEN,
            detail: "Create a client from an existing service-issued auth token",
          },
        ],
        { placeHolder: "How do you want to add the Jumpstarter client?" },
      );
      if (!method) {
        return;
      }
      if (method.label === OIDC) {
        await addClientViaOidc(runInTerminal);
      } else {
        await addClientViaToken(services, afterMutation, showError);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Add-client wizard branches
// ---------------------------------------------------------------------------

async function addClientViaOidc(
  runInTerminal: (name: string, args: string[]) => Promise<void>,
): Promise<void> {
  const target = await vscode.window.showInputBox({
    title: "Add Jumpstarter Client — OIDC login",
    prompt: "Endpoint to log in to, optionally prefixed with a client name",
    placeHolder: "myclient@jumpstarter.example.com",
    ignoreFocusOut: true,
    validateInput: validateLoginTarget,
  });
  if (target === undefined) {
    return;
  }
  await runInTerminal("jmp login", buildLoginArgs(target));
  void vscode.window.showInformationMessage(
    "Complete the login in the terminal (a browser window may open). The new client appears automatically once created.",
  );
}

async function addClientViaToken(
  services: Services,
  afterMutation: () => Promise<void>,
  showError: (action: string, err: unknown) => void,
): Promise<void> {
  const title = "Add Jumpstarter Client — API token";
  const ask = (
    step: number,
    prompt: string,
    options: Partial<vscode.InputBoxOptions> = {},
  ): Thenable<string | undefined> =>
    vscode.window.showInputBox({
      title: `${title} (${step}/5)`,
      prompt,
      ignoreFocusOut: true,
      ...options,
    });

  const alias = await ask(1, "Local alias for this client", {
    placeHolder: "default",
    validateInput: validateAlias,
  });
  if (alias === undefined) {
    return;
  }
  const namespace = await ask(2, "Client namespace on the controller", {
    placeHolder: "jumpstarter-lab",
    validateInput: validateRequired("Namespace"),
  });
  if (namespace === undefined) {
    return;
  }
  const name = await ask(3, "Client name on the controller", {
    placeHolder: "my-client",
    validateInput: validateRequired("Name"),
  });
  if (name === undefined) {
    return;
  }
  const endpoint = await ask(4, "Jumpstarter service (gRPC) endpoint", {
    placeHolder: "grpc.jumpstarter.example.com:443",
    validateInput: validateRequired("Endpoint"),
  });
  if (endpoint === undefined) {
    return;
  }
  const token = await ask(5, "Auth token issued by the Jumpstarter service", {
    password: true,
    validateInput: validateRequired("Token"),
  });
  if (token === undefined) {
    return;
  }

  try {
    // JmpService.run applies redactSecretArgs before logging, so the argv is
    // safe to hand over as-is.
    await services.jmp.run(
      buildClientCreateArgs({
        alias: alias.trim(),
        namespace: namespace.trim(),
        name: name.trim(),
        endpoint: endpoint.trim(),
        token: token.trim(),
      }),
    );
  } catch (err) {
    showError(`Failed to create client '${alias.trim()}'`, err);
    return;
  }
  await afterMutation();
  const setCurrent = await vscode.window.showInformationMessage(
    `Jumpstarter client '${alias.trim()}' created.`,
    "Set as Current",
  );
  if (setCurrent === "Set as Current") {
    try {
      await services.jmp.useClient(alias.trim());
      await afterMutation();
    } catch (err) {
      showError(`Failed to set current client to '${alias.trim()}'`, err);
    }
  }
}
