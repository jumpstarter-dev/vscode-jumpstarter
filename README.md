# ⚡ Jumpstarter VS Code

Provides [Jumpstarter](https://jumpstarter.dev) Hardware-in-the-Loop (HIL) testing support to [Visual Studio Code](https://code.visualstudio.com/) via the [Jumpstarter CLI](https://docs.jumpstarter.dev/main/cli/index.html).

The extension reads Jumpstarter state through the `jmp` CLI found in your
project's active Python environment. Manifest apply uses `kubectl` as a
fallback until `jmp admin apply` is available upstream.

## Requirements

- The [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python)
  with an active interpreter/virtualenv selected.
- `jumpstarter-cli` installed in that environment. The extension is compatible
  with the current `main` branch; see [Jumpstarter CLI compatibility](#jumpstarter-cli-compatibility)
  for the optional integration-branch features. The extension resolves `jmp`
  as `<python> -m jumpstarter_cli`; alternatively point the `jumpstarter.jmpPath`
  setting at a specific `jmp` executable.
- The [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
  for config validation and completion (optional; the rest works without it).
- A Jumpstarter client configuration (`jmp login` / `jmp config client create`)
  to talk to a controller — the extension can create one for you (see below).
- For the Administration view only: a kubeconfig with access to the cluster
  the Jumpstarter CRDs are installed in. Without one, that view stays hidden
  and everything else works as before. No Kubernetes extension is required —
  administration listings go through `jmp admin`, which reads the kubeconfig itself.
- For manifest apply/validation with CLI `main`: `kubectl` on the extension
  host's PATH (or set `jumpstarter.kubectlPath`).

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

## Jumpstarter CLI compatibility

Jumpstarter CLI compatibility is explicit. The
current `main` branch (reviewed at `ca3b4831`) contains the prerequisite PRs needed for authentication,
JSON status output, exporter/lease listing, client redaction, driver listing,
`jmp describe` (without driver introspection), and administration labels:

| Change | Status on `main` |
| ------ | ---------------- |
| `cli-auth-status-json` | [merged, #1037](https://github.com/jumpstarter-dev/jumpstarter/pull/1037) |
| `cli-json-status-names` | [merged, #1038](https://github.com/jumpstarter-dev/jumpstarter/pull/1038) |
| `cli-fix-exporter-lease-merge` | [merged, #1035](https://github.com/jumpstarter-dev/jumpstarter/pull/1035) |
| `cli-logs-to-stderr` | [merged, #1034](https://github.com/jumpstarter-dev/jumpstarter/pull/1034) |
| `cli-client-list-redact-credentials` | [merged, #1036](https://github.com/jumpstarter-dev/jumpstarter/pull/1036) |
| `cli-driver-list-json` | [merged, #1041](https://github.com/jumpstarter-dev/jumpstarter/pull/1041) |
| `cli-describe` | [merged, #1043](https://github.com/jumpstarter-dev/jumpstarter/pull/1043) |
| `cli-admin-object-labels` | [merged, #1044](https://github.com/jumpstarter-dev/jumpstarter/pull/1044) |

The remaining prerequisites are deferred for now: `cli-fix-shell-hook-log`
([#1039](https://github.com/jumpstarter-dev/jumpstarter/pull/1039)),
`client-introspect-lib`
([#1042](https://github.com/jumpstarter-dev/jumpstarter/pull/1042)),
`cli-admin-apply`
([#1046](https://github.com/jumpstarter-dev/jumpstarter/pull/1046)), and
`cli-import-no-credentials`
([#1045](https://github.com/jumpstarter-dev/jumpstarter/pull/1045)) remain
open. Lease driver introspection is now proposed as `cli-describe-drivers`
([#1070](https://github.com/jumpstarter-dev/jumpstarter/pull/1070)), depending on
#1042. `cli-driver-schema` and `cli-admin-exportersets` remain branch-only changes.

The pending shell-log and missing-credentials fixes do not add APIs: shells
and config imports remain available on `main`, but may show misleading hook
messages or a less helpful error when credentials have not been issued.

The extension defaults to the current-main contract. The features requiring
the branch-only CLI APIs — driver schema completion, lease driver browsing,
and exporter-set administration — are disabled by default by
`jumpstarter.experimentalCliFeatures`. Driver schemas additionally require
`jumpstarter.experimentalDriverSchemas` (also default `false`), so other
experimental features can be enabled without importing local driver modules
for schema discovery. Only enable schema discovery for trusted driver packages.
Without it, bundled YAML schemas and manual driver allow-list entry still work.
Resource drafting, apply, and validation
work on `main` using `kubectl apply` and `kubectl apply --dry-run=server`.
With experimental CLI features enabled, apply uses `jmp admin apply` instead.
To try the complete integration build,
check out the branch and opt in:

```sh
git clone https://github.com/jumpstarter-dev/jumpstarter.git
cd jumpstarter
git switch ide-cli-integration
cd python
make sync            # uv sync --all-packages --all-extras -> python/.venv
```

Then select `<jumpstarter>/python/.venv/bin/python` in VS Code and enable
`jumpstarter.experimentalCliFeatures`, or configure both settings directly:

```json
{
  "jumpstarter.jmpPath": "<jumpstarter>/python/.venv/bin/jmp",
  "jumpstarter.experimentalCliFeatures": true,
  "jumpstarter.experimentalDriverSchemas": true
}
```

Do not enable that flag with a `jmp` from current `main`; it is specifically
for the integration branch. Older releases are not the supported baseline:
version checks disable some optional features, but do not guarantee that all
polling commands or JSON fields exist. Use current `main` for the default mode.

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
- Expand an in-use lease to browse its **drivers and their commands**; click
  a command (e.g. `j power on`) to run it in a lease terminal. This requires
  the integration-branch CLI and `jumpstarter.experimentalCliFeatures`.
  The new API is `jmp describe lease --drivers` with a `driver_tree` JSON field;
  older integration builds using `--devices` are supported through a compatibility
  fallback. These are software driver clients, not a physical hardware inventory
  (see [terminology audit](docs/driver-device-terminology.md)).
- **Run Current File in Lease** — runs the active editor file with `python`
  inside the lease session.
- **Extend Lease…**, **End Lease**, **Copy JMP_LEASE Export Line**,
  **Toggle Ended Leases**.
- **Connect to Exporter Directly…** (the plug button) opens a session against
  a standalone exporter by `host:port`, with an optional passphrase. There is
  no controller in that path, so it is a session rather than a lease and does
  not appear in this list.

### Screens and tools from Jumpstarter Web

With [Jumpstarter Web](https://github.com/jumpstarter-dev/jumpstarter-web)
(`jumpstarter-web`, optional) installed in the same environment as `jmp`, the
parts of a lease VS Code has no view for open beside the editor:

- A driver whose client an installed Jumpstarter Web plugin has a centre view
  for (a display's **Screen**, a tool such as the **Appium Inspector**) shows
  an **Open View** button on its row in the Leases view. It opens that one
  view, for that one driver, in a tab with the view's icon. Serial and SSH
  consoles are not offered: those are VS Code terminals.
- **Open Screen and Tools** on a lease opens the lease's screen and Appium
  Inspector together (`jumpstarter.webUi.tools` says which).
- **Open Full Web UI in Browser** opens the whole workbench.

One `jumpstarter-web serve` is started per lease, inside the lease session
(`jmp shell --lease L -- jumpstarter-web serve`), the first time a view is
asked for, and reused after. It listens on loopback only and stops with the
window, with the lease, or with **Jumpstarter: Stop Web UI Servers**. In a
remote window or an Eclipse Che workspace the port is reached through the
address VS Code forwards it to, and the server is told that address and asks
for its per-launch token (not verified on a real Che yet).

A view opens in a panel beside the editor that looks like the rest of the
window: the panel is a webview that frames the page and passes it VS Code's
theme (light or dark, the editor's colours, its font), and the page shows the
view alone, without a title bar or status bar of its own. The server lets
only this window's panels frame it (`jumpstarter.webUi.frameOrigins`). In a
browser-hosted VS Code (Eclipse Che, code-server) the browser cannot reach the
workspace's loopback: the workspace declares ports with addresses of their
own and tells the extension (`jumpstarter.webUi.endpoints`, or the
environment), together with the origin its editor is served from. Run on
Eclipse Che 7.125: the Appium Inspector works there; a display's live video
does not yet (its relay is reachable from the workspace's own machine only). `jumpstarter.webUi.openIn: "browser"` opens views in the system browser
instead.

Which drivers have a view is read from `jumpstarter-web plugins -o json`; with
a Jumpstarter Web that predates that command, use the lease-level commands.

### Administration view

Appears only when this machine can actually administer a cluster: a kubeconfig
that resolves and a cluster serving the Jumpstarter CRDs. Everything else in
the extension looks through one client's eyes; this view uses `jmp admin`, so
it shows **every** client, exporter, exporter set and lease in a namespace,
whoever owns them. Exporter-set listing requires the integration-branch CLI
and `jumpstarter.experimentalCliFeatures`.

- The namespace follows your current client's config unless you set one
  (**Administer Namespace…**, or `jumpstarter.admin.namespace`).
- **Import Client Config** / **Import Exporter Config** fetch the credentials
  the cluster issued for an existing resource (`jmp admin import`) and open the
  resulting YAML for editing. For a client you are asked which driver packages
  it may load: enter client package patterns on `main`, or choose from installed
  drivers when experimental CLI features are enabled.
- **New Cluster Resource…** drafts a **Client**, **Exporter** or
  **ExporterSet** as commented YAML and opens it. Nothing is sent until you
  press **Apply to Cluster** (`kubectl apply` on `main`, experimental `jmp admin apply`
  otherwise), so the parts a wizard cannot
  ask about — an exporter set's template, a client's labels — are edited
  first. **Validate Manifest Against the Cluster** runs the same thing as a
  server-side dry run.
- Any YAML file with a `jumpstarter.dev` `apiVersion` gets the same
  **Apply to Cluster** button in its editor title, so manifests kept in a repo
  apply from here too.
- Apply and validation use the Administration view's namespace, kubeconfig,
  and context. With `kubectl`, an explicit manifest namespace must match the
  selected namespace. Standard `kubectl apply` semantics apply to the whole file.
- After applying through `jmp`, the extension offers to import generated configs.
  With the `kubectl` fallback, use **Import Client Config** / **Import Exporter
  Config** once the controller has issued credentials. Failed applies are never
  automatically retried through the other backend.
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
| `jumpstarter.kubectlPath` | `"kubectl"` | Executable used for manifest apply/validation when experimental `jmp admin apply` is unavailable. |
| `jumpstarter.experimentalCliFeatures` | `false` | Enable CLI APIs still on `ide-cli-integration` (driver schemas, driver browsing, exporter-set administration, and `jmp admin apply` instead of `kubectl`). |
| `jumpstarter.pollIntervalSeconds` | `15` | How often (in seconds) the Jumpstarter views poll the controller for exporters and leases (minimum 5). The Administration view polls at half this rate, and never faster than every 30s. |
| `jumpstarter.webUi.tools` | unset | What **Open Screen and Tools** shows of a lease: Jumpstarter Web plugin ids, view ids (`hmi/screen`) or kinds of centre view (`@display`, `@tool`, `@terminal`). Unset, it is every installed plugin with a display or a tool to show. An empty list shows the whole workbench. |
| `jumpstarter.webUi.openIn` | `"panel"` | Where a lease's screen and tools, and a driver's view, open: `panel` (beside the editor, themed like the window) or `browser` (the system browser). |
| `jumpstarter.webUi.frameOrigins` | unset | What may show Jumpstarter Web in a frame (`jumpstarter-web serve --allowed-frame-origin`). Unset: a panel of a desktop window, or what `JUMPSTARTER_WEB_FRAME_ORIGINS` names (a workspace in the browser: the origin its editor is served from). |
| `jumpstarter.webUi.endpoints` | `{}` | For a workspace in the browser (Eclipse Che, code-server): ports of the container that have an address of their own, `{"7071": "https://…"}`. Jumpstarter Web listens on one for each lease whose views are open. Empty: `JUMPSTARTER_WEB_ENDPOINTS` (`7071=https://…,…`), else a loopback port. |
| `jumpstarter.webUi.path` | `""` | Path to a `jumpstarter-web` executable. Empty takes it from the environment `jmp` runs from. |
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

The tests are hermetic — no cluster, no controller, not even Python.
`src/test/fixtures/fake-jmp.mjs` and `fake-kubectl.mjs` replace the CLI executables
with scripts that return known data, so everything above them runs for real.
The harness sets `jumpstarter.jmpPath` and `jumpstarter.kubectlPath` during
activation, including for default-mode apply and validation tests.

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
driver tree with its prompted arguments. The host is started with
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
