import * as vscode from "vscode";
import { Services } from "../services";
import { McpServer, mcpServers } from "./mcp/model";

/** The id of `contributes.mcpServerDefinitionProviders` in package.json. */
export const MCP_PROVIDER_ID = "jumpstarter.mcp";

/** For the integration tests: what the editor's agents are offered. */
export interface McpApi {
  /** False where the editor has no MCP registry (before VS Code 1.101). */
  registered: boolean;
  servers(): Promise<McpServer[]>;
}

/**
 * Offers Jumpstarter's MCP server to the agents of this editor: no
 * `mcp.json` to write, and the server is the `jmp` of the views (the selected
 * interpreter's, `jumpstarter.jmpPath`, or the one on PATH), so an agent
 * sees the clients, exporters and leases the person does.
 *
 * The editor asks for the definitions when a chat needs them and starts the
 * server itself; this only says what to start, and says so again when the
 * interpreter, the CLI or the setting changes.
 */
export function registerMcp(context: vscode.ExtensionContext, services: Services): McpApi {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);

  // `jmp mcp --help` per command line: it says whether jumpstarter-mcp is installed beside that jmp
  const probed = new Map<string, Promise<boolean>>();
  const hasMcp = (key: string, invocation: { command: string; prefixArgs: string[] }): Promise<boolean> => {
    let known = probed.get(key);
    if (known === undefined) {
      known = services.jmp.run(["mcp", "--help"], { invocation, timeoutMs: 20_000 }).then(
        () => true,
        () => false,
      );
      probed.set(key, known);
    }
    return known;
  };

  const servers = async (): Promise<McpServer[]> => {
    const enabled = vscode.workspace.getConfiguration("jumpstarter").get<boolean>("mcp.enabled", true);
    if (!enabled) {
      return [];
    }
    let invocation;
    try {
      invocation = await services.jmp.getInvocation();
    } catch {
      return [];
    }
    const key = [invocation.command, ...invocation.prefixArgs].join("\0");
    const availability = services.jmp.getAvailability();
    const version = availability?.kind === "ok" ? availability.version.gitVersion : undefined;
    return mcpServers({
      enabled,
      invocation,
      hasMcp: await hasMcp(key, invocation),
      version,
      env: process.env,
    });
  };

  const refresh = (): void => {
    probed.clear();
    changed.fire();
  };
  context.subscriptions.push(
    services.jmp.onDidChangeInterpreter(refresh),
    services.jmp.onDidChangeAvailability(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("jumpstarter.mcp") || e.affectsConfiguration("jumpstarter.jmpPath")) {
        refresh();
      }
    }),
  );

  // the registry is VS Code 1.101's; an older editor (or a fork without it) simply has no agents to tell
  const lm = vscode.lm as Partial<typeof vscode.lm> | undefined;
  if (typeof lm?.registerMcpServerDefinitionProvider !== "function") {
    return { registered: false, servers };
  }
  context.subscriptions.push(
    lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: async () =>
        (await servers()).map(
          (server) =>
            new vscode.McpStdioServerDefinition(server.label, server.command, server.args, server.env, server.version),
        ),
    }),
  );
  return { registered: true, servers };
}
