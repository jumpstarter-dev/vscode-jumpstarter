# ⚡ Jumpstarter VS Code

Provides [Jumpstarter](https://jumpstarter.dev) Hardware-in-the-Loop (HIL) testing support to [Visual Studio Code](https://code.visualstudio.com/) via the [Jumpstarter CLI](https://docs.jumpstarter.dev/main/cli/index.html).

The extension drives everything through the `jmp` CLI found in your project's
active Python environment, so what you see in VS Code always matches what
`jmp` would tell you in a terminal.

## Requirements

- The [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python)
  with an active interpreter/virtualenv selected.
- `jumpstarter-cli` installed in that environment — **for now, from the
  `ide-cli-integration` branch** (see [Jumpstarter CLI branch](#jumpstarter-cli-branch-temporary)).
  The extension resolves `jmp` as `<python> -m jumpstarter_cli`; alternatively
  point the `jumpstarter.jmpPath` setting at a specific `jmp` executable.
- The [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
  for config validation and completion (optional; the rest works without it).
- A Jumpstarter client configuration (`jmp login` / `jmp config client create`)
  to talk to a controller — the extension can create one for you (see below).
- For the Administration view only: a kubeconfig with access to the cluster
  the Jumpstarter CRDs are installed in. Without one, that view stays hidden
  and everything else works as before. No Kubernetes extension is required —
  administration goes through `jmp admin`, which reads the kubeconfig itself.

## Installation

The extension is not published to the Marketplace yet; build and install it
from source:

```sh
git clone https://github.com/jumpstarter-dev/vscode-jumpstarter.git
cd vscode-jumpstarter
git switch extension-mvp

corepack enable && pnpm install
pnpm run package:vsix
code --install-extension vscode-jumpstarter-*.vsix
```

Reload the VS Code window afterwards. Reinstalling over the same version
number replaces the files on disk but leaves the running extension in place,
so reload (or bump the version) whenever you rebuild.

## Jumpstarter CLI branch (temporary)

The extension reads everything from `jmp`, and several things it needs are
not in a released `jumpstarter-cli` yet. Until those land upstream, point
VS Code at a checkout of the
[`ide-cli-integration`](https://github.com/jumpstarter-dev/jumpstarter/tree/ide-cli-integration)
branch:

```sh
git clone https://github.com/jumpstarter-dev/jumpstarter.git
cd jumpstarter
git switch ide-cli-integration

cd python
make sync            # uv sync --all-packages --all-extras -> python/.venv
```

Then either select that environment in VS Code (**Python: Select
Interpreter** → `<jumpstarter>/python/.venv/bin/python`), or set:

```json
{ "jumpstarter.jmpPath": "<jumpstarter>/python/.venv/bin/jmp" }
```

That branch merges the following changes, each also on its own branch for
upstream review:

| Branch | What the extension needs it for |
| ------ | ------------------------------- |
| `cli-auth-status-json` | `jmp auth status -o json`, so background polling can check a token without triggering an interactive login |
| `cli-json-status-names` | Exporter status as names rather than protobuf integers, and the derived lease status, in JSON output |
| `cli-fix-exporter-lease-merge` | `--with leases` no longer drops each exporter's status and labels |
| `cli-logs-to-stderr` | Log lines on stderr, so they stop corrupting `-o json` payloads |
| `cli-fix-shell-hook-log` | No phantom "waiting for beforeLease hook" when attaching to a ready lease |
| `cli-client-list-redact-credentials` | `jmp config client list -o json` no longer prints tokens |
| `cli-driver-list-json` / `cli-driver-schema` | Installed driver types and their config keys, for YAML completion |
| `client-introspect-lib` / `cli-describe` / `cli-describe-devices` | `jmp describe lease --devices`, which powers the device tree and its runnable commands |
| `cli-admin-exportersets` | `jmp admin get exporterset`, and the controller labels that let a client tell which pool an exporter belongs to |
| `cli-admin-apply` | `jmp admin apply -f`, which is how the new-resource wizards send an edited manifest to the cluster |
| `cli-import-no-credentials` | A readable error, rather than a traceback, for a resource whose credentials the controller has not issued yet |
| `cli-admin-object-labels` | Labels in `jmp admin get client\|exporter -o json`, so the Administration view can show what an exporter is selected by |

With a `jmp` that predates these changes the extension still starts, and the
Clients view and YAML driver completion switch themselves off. The rest is
best-effort: the device tree and anything else built on a missing subcommand
reports the CLI's error in place rather than silently doing nothing. The
capability probe keys off `jmp version`, which cannot distinguish a released
build from one carrying these unreleased changes — so use the branch above
until they land.

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
- Exporters belonging to an **exporter set** (a pool provisioned on demand)
  are grouped under the pool, described as `available/total`, with a
  **Lease from Exporter Set** action that leases any member — including when
  the pool is cold and one has to be provisioned first.
- **Local Exporters**, in their own collapsible section at the bottom: configs
  on this machine the controller does not know about. They are served from
  here (`jmp shell --exporter <alias>`) with no controller and no lease, which
  is how you develop a driver before there is a cluster to register it with.

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
- **Extend Lease…**, **End Lease**, **Copy JMP_LEASE Export Line**,
  **Toggle Ended Leases**.
- **Connect to Exporter Directly…** (the plug button) opens a session against
  a standalone exporter by `host:port`, with an optional passphrase. There is
  no controller in that path, so it is a session rather than a lease and does
  not appear in this list.

### Administration view

Appears only when this machine can actually administer a cluster: a kubeconfig
that resolves and a cluster serving the Jumpstarter CRDs. Everything else in
the extension looks through one client's eyes; this view uses `jmp admin`, so
it shows **every** client, exporter, exporter set and lease in a namespace,
whoever owns them.

- The namespace follows your current client's config unless you set one
  (**Administer Namespace…**, or `jumpstarter.admin.namespace`).
- **Import Client Config** / **Import Exporter Config** fetch the credentials
  the cluster issued for an existing resource (`jmp admin import`) and open the
  resulting YAML for editing. For a client you are asked which driver packages
  it may load, offered from the drivers installed in your environment.
- **New Cluster Resource…** drafts a **Client**, **Exporter** or
  **ExporterSet** as commented YAML and opens it. Nothing is sent until you
  press **Apply to Cluster** (`jmp admin apply`), so the parts a wizard cannot
  ask about — an exporter set's template, a client's labels — are edited
  first. **Validate Manifest Against the Cluster** runs the same thing as a
  server-side dry run.
- Any YAML file with a `jumpstarter.dev` `apiVersion` gets the same
  **Apply to Cluster** button in its editor title, so manifests kept in a repo
  apply from here too.
- After applying a Client or Exporter, the extension offers to import the
  config the controller generated for it.
- Leases show active ones by default; **Toggle Ended Leases** includes the
  history.

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
| `jumpstarter.pollIntervalSeconds` | `15` | How often (in seconds) the Jumpstarter views poll the controller for exporters and leases (minimum 5). The Administration view polls at half this rate, and never faster than every 30s. |
| `jumpstarter.admin.namespace` | `""` | Namespace the Administration view reads. Empty follows the current client config's namespace. |
| `jumpstarter.admin.kubeconfig` | `""` | Kubeconfig for cluster administration. Empty uses the usual `KUBECONFIG` / `~/.kube/config` resolution. |
| `jumpstarter.admin.context` | `""` | Kubeconfig context for cluster administration. Empty uses the current context. |

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

Logic that can be unit-tested lives beside its feature in a `vscode`-free
module (`src/features/<name>/*.ts`), because `pnpm run test:unit` runs the
compiled output under plain Node.

### End-to-end tests

`pnpm test` launches a real VS Code, activates the extension in it, and drives
the actual commands and views. It needs a display; on a headless machine run it
under `xvfb-run -a pnpm test`.

The tests are hermetic — no cluster, no controller, not even Python — because
the extension reaches the outside world through exactly one channel: it spawns
`jmp` and parses stdout. `src/test/fixtures/fake-jmp.mjs` replaces that one
binary with a script that answers each subcommand with known data, so
everything above it runs for real. The harness points `jumpstarter.jmpPath` at
it during activation.

Two things make the fake useful as a test double:

- every invocation is appended to `$JMP_FAKE_LOG`, so a test can assert what
  the extension actually asked the CLI to do (`expectCall("admin", "apply")`);
- `$JMP_FAKE_FAIL="admin get"` makes the matching subcommand exit non-zero, so
  error handling is as easy to test as the happy path.

An invocation the fake does not recognize exits 2, so a test that drifts from
the real argv fails loudly instead of silently passing.

All 40 contributed commands are exercised, along with the scenarios that only
show up at this level: the views' error rows, an expired token stopping the
polling instead of triggering a browser login, the confirmations before a lease
is ended or a client deleted, the argv handed to every terminal, and the
device tree with its prompted arguments. The host is started with
`JMP_CLIENT_CONFIG_HOME` pointing at a scratch directory (and the harness
refuses to run against a real one), so the tests that scaffold and import
configs write real files without touching yours.

`src/test/integration/harness.ts` has the rest: `activateWithFakeCli()`,
`treeLabels()` / `childLabels()` / `findItem()` for asserting on what a view
renders, `waitFor()` for the asynchronous parts, and `stubUi()` to answer
QuickPicks, input boxes and notification buttons so an interactive command can
be driven end to end:

```ts
const restore = stubUi({ quickPicks: ["fake", "Allow none for now"] });
try {
  await vscode.commands.executeCommand("jumpstarter.importClientConfig");
} finally {
  restore();
}
expectCall("admin", "import", "client", "fake");
```

Views are reachable because `activate()` returns the tree providers (see
`JumpstarterApi` in `src/extension.ts`); that API exists for these tests and
has no other consumer.

### Testing against local hardware-free exporters

You do not need real hardware. Register a mock exporter against any
controller and run it locally:

```sh
jmp admin create exporter mock -l board=mock --save   # writes exporters/mock.yaml
```

Add drivers to the `export:` block of that file — `MockPower`, an
`EchoNetwork` console and a `Shell` driver give a device tree with runnable
commands — then serve it:

```sh
jmp run --exporter mock
```

It appears in the Exporters view, and leasing it makes its device tree
browsable from the Leases view.
