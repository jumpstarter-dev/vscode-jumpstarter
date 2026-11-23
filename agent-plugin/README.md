# Jumpstarter agent plugin

An [Agent Plugins 1.0](https://agent-plugins.org/specification) plugin: what an agent needs to work with
[Jumpstarter](https://jumpstarter.dev) devices.

* `skills/jumpstarter-devices`: leasing a device and using its drivers through Jumpstarter's MCP tools.
* `skills/jumpstarter-robot-tests`: writing and running Robot Framework suites against leased devices.
* `mcp.json`: Jumpstarter's MCP server, `jmp mcp serve` (the `jmp` on `PATH`, with the `jumpstarter-mcp` package).

**With the Jumpstarter extension for VS Code installed, nothing here needs installing.** The extension contributes
the same skills (`contributes.chatSkills`) and registers the MCP server itself, with the `jmp` its views use
(`jumpstarter.mcp.enabled`). Installing the plugin as well would list the server twice.

Use the plugin on its own where the extension is not: GitHub Copilot CLI, or an editor without the extension. In VS
Code, "Chat: Install Plugin from Source" takes this folder or the repository's URL.
