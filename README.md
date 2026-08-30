# ⚡ Jumpstarter VS Code

Provides [Jumpstarter](https://jumpstarter.dev) Hardware-in-the-Loop (HIL) testing support to [Visual Studio Code](https://code.visualstudio.com/) via the [Jumpstarter CLI](https://docs.jumpstarter.dev/main/cli/index.html).

The extension drives everything through the `jmp` CLI found in your project's
active Python environment, so what you see in VS Code always matches what
`jmp` would tell you in a terminal.

## Requirements

- The [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python)
  with an active interpreter/virtualenv selected.
- `jumpstarter-cli` installed in that environment (`pip install jumpstarter-cli`,
  or the jumpstarter monorepo's own venv). The extension resolves `jmp` as
  `<python> -m jumpstarter_cli`; alternatively point the `jumpstarter.jmpPath`
  setting at a specific `jmp` executable.
- A Jumpstarter client configuration (`jmp login` / `jmp config client create`)
  to talk to a controller — the extension can create one for you (see below).

## Features

### Clients view

Lists every configured Jumpstarter client (from `~/.config/jumpstarter/clients`)
with a per-client auth badge (valid / expiring soon / expired / not logged in).

- **Add Client…** — wizard supporting both browser-based OIDC login
  (`jmp login`) and token-based client creation. Tokens are masked on input
  and redacted from all logs.
- **Set as Current Client**, **Re-authenticate** (opens a terminal for the
  browser/device flow), **Open Client Config File**, **Delete Client**.
- A status bar item shows the current client and its auth state; click it to
  switch clients.
- External `jmp login` / `jmp config client use` runs are picked up
  automatically by watching the config directory.

### Exporters view

Live view of the exporters visible to the current client, color-coded by
status (available / leased / offline / hook-failed), with labels and current
leaseholder in the tooltip.

- **Acquire Lease** directly on an available exporter (pick a duration).
- **Lease by Label Selector…** — build a `key=value` selector interactively
  with a live match count.
- **Filter Exporters by Selector** to narrow the view.

### Leases view

Your leases with live remaining-time countdowns. Leases created from
VS Code are tagged `jumpstarter.dev/created-by=vscode` and marked with a ⚡
icon.

- **Open Shell in Lease** — a terminal attached to the lease
  (`jmp shell --lease …`).
- Expand an in-use lease to browse its **devices and driver commands**; click
  a command (e.g. `j power on`) to run it in a lease terminal.
- **Run Current File in Lease** — runs the active editor file with `python`
  inside the lease session.
- **Extend Lease…**, **Release Lease**, **Copy JMP_LEASE Export Line**,
  **Toggle Ended Leases**.

### YAML schema support

Client, exporter and user config YAML files under `~/.config/jumpstarter`
(and `/etc/jumpstarter/exporters`) get validation and completion when the
[YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
is installed. **New Client Config** / **New Exporter Config** scaffold
schema-valid files (the exporter scaffold lists the driver types installed in
your environment).

### Background polling that never steals focus

Views poll `jmp` on a configurable interval, pause while hidden, back off
while the window is unfocused — and **stop entirely when your token expires**,
surfacing a re-authenticate action instead of hanging a background login.

## Pinning a lease for test runs

Hardware tests written with the `JumpstarterTest` pytest fixture normally
acquire a fresh lease when the test session starts and **release it when the
session ends** — between two runs your board can be handed to someone else,
and every run pays the lease-acquisition wait.

**Pin Lease for Test Runs** (`jumpstarter.pinLeaseForTests`, also available on
lease rows in the Leases view) fixes that:

1. Pick a client and an active lease (rows you created from the extension are
   tagged `jumpstarter.dev/created-by=vscode`).
2. The extension exports two environment variables into the workspace via
   VS Code's `EnvironmentVariableCollection`:
   - `JMP_LEASE=<lease name>` — the jumpstarter client library's attach hook.
   - `JMP_CLIENT=<client alias>` — informational: handy for scripts and
     wrappers (`jmp shell --client "$JMP_CLIENT" --lease "$JMP_LEASE"`); the
     `jmp` CLI itself does not read it (yet).
3. A **"Tests → lease \<name\>"** status bar entry appears while pinned; click
   it to switch to another lease or clear the pin
   (`jumpstarter.clearTestPin`).

The pin is stored per workspace and restored when the window reopens. On
restore the extension verifies the lease is still active; if it has ended,
expired, or disappeared (or its client config was deleted), the pin is cleared
and you get a notification. Verification never runs when your token is
expired — it would otherwise trigger an interactive login.

### How the fixture attaches (and why it does not steal your lease)

`ClientConfigV1Alpha1.lease()` — which `JumpstarterTest`'s `client` fixture
uses under the hood — checks `JMP_LEASE` first. When set, it **attaches to
that existing lease instead of creating one, and does not release it on
exit**. So with a pin active:

- `pytest` from the Test Explorer or an integrated terminal reuses your lease.
- The lease stays yours after the run; release it explicitly from the Leases
  view (or `jmp delete leases <name>`) when you are done.
- Without a pin, behavior is unchanged: the fixture acquires by `selector` and
  releases at the end of the run.

Environment variable collections apply to **newly created** terminals only —
restart existing terminals after pinning or clearing.

### Fallback: `python.envFile`

Current versions of the ms-python extension apply VS Code environment variable
collections to test runs. If yours does not (test runs ignore the pin), fall
back to an env file:

1. Create `.env` in the workspace root:

   ```dotenv
   JMP_LEASE=<lease name from the status bar / Leases view>
   ```

2. Point the Python extension at it in `.vscode/settings.json` (this is the
   default value, so usually just creating `.env` is enough):

   ```json
   { "python.envFile": "${workspaceFolder}/.env" }
   ```

Remember to remove the line when you clear the pin — the env file is not
managed by the extension.

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `jumpstarter.jmpPath` | `""` | Path to a `jmp` executable. When set, it is invoked directly instead of resolving `jumpstarter_cli` from the active Python environment. |
| `jumpstarter.pollIntervalSeconds` | `15` | How often (in seconds) the Jumpstarter views poll the controller for exporters and leases (minimum 5). |

## Security notes

- Tokens and credentials are never logged or displayed; `jmp config client
  list` is always used in its redacted form, and secret-bearing command-line
  arguments are masked before any logging.
- Remote commands are never run in the background with an expired token
  (which would trigger an interactive browser login); the extension checks
  `jmp auth status` first and asks you to re-authenticate instead.

## Development

```sh
corepack enable && pnpm install
pnpm run compile      # type-check + lint + bundle to dist/
pnpm run test:unit    # pure-logic tests under plain Node (no VS Code host)
pnpm run package:vsix # build the installable .vsix
```

Press **F5** ("Run Extension") to launch an Extension Development Host with
the watch build.
