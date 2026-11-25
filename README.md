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
current `main` branch (reviewed at `a45e3523`) contains the prerequisite PRs needed for authentication,
JSON status output, exporter/lease listing, client redaction, driver listing, driver schema discovery,
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
| `cli-driver-schema` | [merged, #1071](https://github.com/jumpstarter-dev/jumpstarter/pull/1071) |

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
#1042. `cli-admin-exportersets` remains a branch-only change.

The pending shell-log and missing-credentials fixes do not add APIs: shells
and config imports remain available on `main`, but may show misleading hook
messages or a less helpful error when credentials have not been issued.

The extension defaults to the current-main contract. The features requiring
the branch-only CLI APIs — lease driver browsing and exporter-set
administration — are disabled by default by
`jumpstarter.experimentalCliFeatures`.

Driver YAML completion, validation and driver-client allow-list suggestions
need no opt-in: they use `jmp driver schema`, which is on `main`. It imports
the driver packages installed in the selected environment to read their
configuration, as running an exporter from that environment would. A `jmp`
without the command (a release before 0.10, or a 0.10 development build from
before #1071) is asked once: the bundled YAML schemas and manual driver
allow-list entry are what is used then.
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
  "jumpstarter.experimentalCliFeatures": true
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
VS Code are tagged `created-by=vscode` and marked with a ⚡
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

#### Leases with members: roles and forwards

A lease made from a **lease template** (or with `jmp create lease --member`)
holds several exporters at once, one for each **role**: a head unit, its phone
and its ECU in one lease. It has no exporter of its own, so its row names the
template it was made from (else its roles), and it expands into what it holds:

```
⚡ ivi-4fj2k   ivi · Degraded · 1h 48m left
   ⚠ Degraded: ecu (Offline) lost its exporter
   headunit    rack3-hu-2 · Bound
      power    PowerClient
         ▶ j headunit power on
   phone       rack3-phone-4 · Bound · optional
   ecu         Lost: Offline · was ecu-9
   bt          headunit.rootcanal → phone.controller · Connected
```

- **Roles**, in the lease's order, each with its exporter and its state:
  `Bound`, `Pending`, `Omitted` (an optional role that was left out) or
  `Lost`, with the reason for the last two.
- A **Degraded** notice when a role lost its exporter. The other roles stay
  usable, and the lease keeps every action of a lease in use.
- **Forwards**, which connect a port on one role to a port on another
  (`jmp create lease --forward`, or the template's): what each connects, with
  an arrow from the port that provides to the ports that require (`↔` between
  the two ends of a path), its state (`Pending`, `Listening`, `Connected`,
  `Disabled`, `Failed`) and what the controller said of a forward that does not
  operate. The state of each end is in the tooltip. The direction comes from
  the ports the exporters declare (`jmp get exporters --with ports`); with a
  CLI that has none, the endpoints are listed without an arrow.
- A bound role expands into **its own drivers and commands**, as a lease of
  one exporter does. A command runs as `j ROLE DRIVER …` (`j headunit power
  on`), which is how the lease's shell names an exporter. The drivers of all
  the roles are read once, inside the lease's session (same requirement as
  driver browsing above).
- **Open Shell in Lease**, **Run Current File**, **Extend Lease…**, **End
  Lease** and **Copy JMP_LEASE Export Line** act on the lease as one: one
  shell with every role (`j ROLE …`, `j-forward status`), and extending or
  ending it applies to every role. It can be pinned for test runs like any
  lease (the pin exports its name in `JMP_LEASE`); whether a test framework
  can drive a lease with members is the framework's to say.

Leases of one exporter are shown as before. The fields are read as the CLI
prints them (`members`, `member_statuses`, `template`, `forwards`,
`forward_statuses` of `jmp get leases -o json`); a CLI from before leases with
members prints none of them, and a field or state a later one adds is shown
as it is named.

### Lease Templates view

Lists the **lease templates** the current client can request
(`jmp get lease-templates`): sets of exporters that belong together, which a
lab administrator published.

- Each template shows its roles (a `*` marks an optional one), how many of
  them have an exporter you can lease now (`2/3 available`, a guide only) and
  its description. It expands into the roles (how each finds its exporter, and
  how many there are to lease), the forwards a lease from it will have, and its
  documentation links, which open in the browser.
- Selecting a template shows its details in the **Details** pane: roles,
  constraints, forwards, links, and the administrator's instructions as plain
  text.
- **Lease This Template…** on a template (or **Jumpstarter: Lease from
  Template…** from the palette, the Leases view and the Exporters view) asks
  which optional roles to leave out and for how long (the template's default
  duration when it has one), then requests it:
  `jmp create lease -t NAME [--without ROLE]… [--duration D]`. The request
  shows in the Leases view while the roles are being bound, and the lease
  appears there with its roles.

The view is hidden when the `jmp` in use has no `lease-templates` command, or
its controller is too old for templates; that is logged to the Jumpstarter
output channel, **Lease from Template…** says why, and nothing else changes.

### Screens and tools from Jumpstarter Web

With [Jumpstarter Web](https://github.com/jumpstarter-dev/jumpstarter-web)
(`jumpstarter-web`, optional) installed in the same environment as `jmp`, the
parts of a lease VS Code has no view for open beside the editor:

- A driver whose client an installed Jumpstarter Web plugin has a centre view
  for (a display's **Screen**, a tool such as the **Appium Inspector**) shows
  an **Open View** button on its row in the Leases view. It opens that one
  view, for that one driver, in a tab with the view's icon. Serial and SSH
  consoles are not offered: those are VS Code terminals.
- **Open Screen** on a lease opens the lease's screen (the first display its
  drivers have a view for) in one tab. Its other views, such as the Appium
  Inspector, open from their drivers: an Inspector starts a session on the
  device, so it opens when it is asked for.
- **Open Full Web UI in Browser** opens the whole workbench.
- A **lease with members** opens as **one view with all its roles**: **Open
  Screen** on the lease shows Jumpstarter Web's view of the lease, one role in
  front and the others beside it (its Companions window), with the lease's
  roles and forwards. **Open Screen** on a bound role, and **Open View** on a
  driver of a role, show that role alone. Jumpstarter Web's links cannot name
  a role of a lease, so a role's views are served by a server of that role:
  the lease's session starts `jumpstarter-web serve` with the role's exporter
  as its device (one more server for each role whose views are open).

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

### Agents: Jumpstarter's MCP tools and skills

An agent in the editor's chat can work with devices as you do, with nothing to configure:

* **MCP server.** The extension registers Jumpstarter's MCP server (`jmp mcp serve`) with the editor, with the same
  `jmp` the views use (the selected interpreter's, `jumpstarter.jmpPath`, or the one on `PATH`), so an agent sees your
  clients, exporters and leases. It is offered when that `jmp` has the `mcp` command (the `jumpstarter-mcp` package);
  `jumpstarter.mcp.enabled` turns it off. It appears under "MCP: List Servers" as **Jumpstarter**. 
* **Leases with members.** An agent lists lease templates and requests one with the CLI
  (`jmp get lease-templates`, `jmp create lease -t NAME`), and uses a role's drivers with
  `jmp shell --lease NAME -- j ROLE DRIVER …`; the `jumpstarter-devices` skill says so. The MCP tools
  themselves connect to a lease of one exporter (`jmp_connect` has no role yet).
* **Skills.** Two [agent skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) come with the
  extension: `jumpstarter-devices` (leasing a device and using its drivers through the MCP tools) and
  `jumpstarter-robot-tests` (Robot Framework suites against leased devices).

This reaches the agents that use the editor's own MCP registry and skills (GitHub Copilot's chat). An agent extension
that keeps a configuration of its own does not read either; for those, and for GitHub Copilot CLI, the same content is
the [agent plugin](agent-plugin/README.md) in this repository ([Agent Plugins 1.0](https://agent-plugins.org/specification)).
VS Code has no way for an extension to install an agent plugin, so the extension contributes the plugin's parts itself.

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
   tagged `created-by=vscode`).
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
| `jumpstarter.pollIntervalSeconds` | `0` | Poll the controller for exporters and leases in the background, this often (in seconds, 5 at least; the Administration view at half the rate, and never faster than every 30s). `0` is no background polling: the views are read when they are shown, when the window regains focus, when you refresh them, and every 5 seconds for two minutes after a lease is acquired or released. |
| `jumpstarter.webUi.tools` | unset | What **Open Screen** shows of a lease. Unset: the lease's screen alone. Set: the Jumpstarter Web plugin ids, view ids (`hmi/screen`) or kinds of centre view (`@display`, `@tool`, `@terminal`) it names, together in one tab; an empty list is the whole workbench. |
| `jumpstarter.webUi.openIn` | `"panel"` | Where a lease's screen and tools, and a driver's view, open: `panel` (beside the editor, themed like the window) or `browser` (the system browser). |
| `jumpstarter.webUi.frameOrigins` | unset | What may show Jumpstarter Web in a frame (`jumpstarter-web serve --allowed-frame-origin`). Unset: a panel of a desktop window, or what `JUMPSTARTER_WEB_FRAME_ORIGINS` names (a workspace in the browser: the origin its editor is served from). |
| `jumpstarter.mcp.enabled` | `true` | Offer Jumpstarter's MCP server (`jmp mcp serve`) to the agents of this editor. It runs with the same `jmp` as the views and needs the `jumpstarter-mcp` package beside it. |
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
