import * as assert from "node:assert";
import { test } from "node:test";
import { mcpEnvironment, mcpServers } from "../../features/mcp/model";

const base = {
  enabled: true,
  invocation: { command: "/venv/bin/python", prefixArgs: ["-m", "jumpstarter_cli"] },
  hasMcp: true,
  version: "0.10.0",
  env: {},
};

test("the server is the jmp of the views, asked to serve MCP", () => {
  assert.deepStrictEqual(mcpServers(base), [
    {
      label: "Jumpstarter",
      command: "/venv/bin/python",
      args: ["-m", "jumpstarter_cli", "mcp", "serve"],
      env: {},
      version: "0.10.0",
    },
  ]);
  const onPath = mcpServers({ ...base, invocation: { command: "/usr/bin/jmp", prefixArgs: [] } });
  assert.deepStrictEqual(onPath[0]?.args, ["mcp", "serve"]);
});

test("nothing is offered when it is switched off, there is no jmp, or that jmp has no mcp command", () => {
  assert.deepStrictEqual(mcpServers({ ...base, enabled: false }), []);
  assert.deepStrictEqual(mcpServers({ ...base, invocation: undefined }), []);
  assert.deepStrictEqual(mcpServers({ ...base, hasMcp: false }), []);
});

test("only Jumpstarter's own variables are named for the server", () => {
  assert.deepStrictEqual(
    mcpEnvironment({
      JMP_CLIENT_CONFIG_HOME: "/cfg",
      JUMPSTARTER_GRPC_INSECURE: "1",
      GRPC_DNS_RESOLVER: "native",
      JMP_EMPTY: "",
      HOME: "/home/u",
      SECRET_TOKEN: "x",
      GONE: undefined,
    }),
    { JMP_CLIENT_CONFIG_HOME: "/cfg", JUMPSTARTER_GRPC_INSECURE: "1", GRPC_DNS_RESOLVER: "native" },
  );
});
