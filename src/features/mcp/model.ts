/**
 * Jumpstarter's MCP server (`jmp mcp serve`) as the editor's agents are told
 * of it. Pure: no `vscode` import, so the unit tests run it in plain Node.
 */

/** How this extension runs `jmp` (JmpService.getInvocation). */
export interface McpInvocation {
  command: string;
  prefixArgs: readonly string[];
}

/** One stdio server, in the shape of `vscode.McpStdioServerDefinition`. */
export interface McpServer {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  version: string | undefined;
}

export const MCP_LABEL = "Jumpstarter";

/**
 * The variables of this window's environment the server is given by name.
 * The editor starts a server with the extension host's environment already,
 * so this only pins what Jumpstarter reads against an agent host that starts
 * it with less.
 */
const PASSED = /^(JMP_|JUMPSTARTER_|GRPC_)/;

export function mcpEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const passed: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (PASSED.test(name) && value !== undefined && value !== "") {
      passed[name] = value;
    }
  }
  return passed;
}

/**
 * The servers to offer: `jmp mcp serve` with the same `jmp` the views use,
 * or none when the setting is off or that `jmp` has no `mcp` command (the
 * `jumpstarter-mcp` package is not installed beside it).
 *
 * `version` is the CLI's: when it changes the editor asks for the tools again.
 */
export function mcpServers(options: {
  enabled: boolean;
  invocation: McpInvocation | undefined;
  hasMcp: boolean;
  version: string | undefined;
  env: Record<string, string | undefined>;
}): McpServer[] {
  if (!options.enabled || options.invocation === undefined || !options.hasMcp) {
    return [];
  }
  return [
    {
      label: MCP_LABEL,
      command: options.invocation.command,
      args: [...options.invocation.prefixArgs, "mcp", "serve"],
      env: mcpEnvironment(options.env),
      version: options.version,
    },
  ];
}
