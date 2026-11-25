#!/usr/bin/env node
/**
 * A stand-in for the `jmp` CLI, for the integration tests.
 *
 * The extension talks to the outside world through exactly one channel — it
 * spawns `jmp` and parses stdout — so replacing that one binary makes the whole
 * extension testable without a cluster, a controller, or even Python. Point
 * the `jumpstarter.jmpPath` setting at this file and every view, command and
 * error path runs for real against known data.
 *
 * Two things make it useful as a test double:
 *   - every invocation is appended to $JMP_FAKE_LOG as a JSON line, so a test
 *     can assert what the extension actually asked the CLI to do;
 *   - $JMP_FAKE_FAIL makes the matching subcommand exit non-zero, so error
 *     handling can be tested as easily as the happy path.
 *
 * An unrecognized invocation exits 2 (the CLI's usage code) rather than
 * returning something bland, so a test that drifts from the real argv fails
 * loudly instead of silently passing.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * What the real CLI printed for leases with members, lease templates and
 * ports (fixtures/cli/README.md says how each file was made). The fake
 * answers with them as they are, so the views are tested against the shapes
 * the CLI has, not against shapes somebody remembered.
 */
const CLI_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "cli");
const fixtureText = (name) => readFileSync(join(CLI_FIXTURES, name), "utf8");
const fixture = (name) => JSON.parse(fixtureText(name));

/** Where the test host keeps its config tree; see .vscode-test.mjs. */
const CONFIG_HOME = process.env.JMP_CLIENT_CONFIG_HOME ?? join(tmpdir(), "jumpstarter-fake");

/** Write a config file if it is not there, and return its path. */
function configFile(kind, alias, body) {
  const dir = join(CONFIG_HOME, kind);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${alias}.yaml`);
  if (!existsSync(file)) {
    writeFileSync(file, body);
  }
  return file;
}

const argv = process.argv.slice(2);

if (process.env.JMP_FAKE_LOG) {
  appendFileSync(process.env.JMP_FAKE_LOG, `${JSON.stringify(argv)}\n`);
}

/** Make one subcommand fail, e.g. JMP_FAKE_FAIL="admin get" */
if (process.env.JMP_FAKE_FAIL && argv.join(" ").startsWith(process.env.JMP_FAKE_FAIL)) {
  process.stderr.write("Error: fake failure requested by the test\n");
  process.exit(1);
}

const has = (...tokens) => tokens.every((token) => argv.includes(token));
const startsWith = (...tokens) => tokens.every((token, i) => argv[i] === token);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

// Model the missing APIs on upstream main instead of silently accepting the
// integration-branch contract in default-mode tests.
if (process.env.JMP_FAKE_MAIN_ONLY && (
  startsWith("driver", "schema") ||
  (startsWith("describe", "lease") && (has("--drivers") || has("--devices"))) ||
  startsWith("admin", "get", "exporterset") ||
  startsWith("admin", "apply")
)) {
  process.stderr.write("Error: experimental command is unavailable on main\n");
  process.exit(2);
}

// A `jmp` from before lease templates has no such command, and one from
// before ports refuses `--with ports`: both are usage errors (exit 2).
if (process.env.JMP_FAKE_NO_TEMPLATES && (
  startsWith("get", "lease-templates") ||
  startsWith("describe", "lease-template") ||
  (startsWith("get", "exporters") && (valueOf("--with") ?? "").split(",").includes("ports"))
)) {
  process.stderr.write(
    startsWith("get", "exporters")
      ? "Error: Invalid value for '--with': 'ports' is not one of 'leases', 'online', 'status'.\n"
      : `Error: No such command '${argv[1]}'.\n`,
  );
  process.exit(2);
}

// A newer `jmp` against a controller from before lease templates.
if (process.env.JMP_FAKE_OLD_CONTROLLER && startsWith("get", "lease-templates")) {
  process.stderr.write("Error: the controller is too old for lease templates: upgrade the controller\n");
  process.exit(1);
}

// A `jmp` from before `get exporters --show-hidden-labels`.
if (process.env.JMP_FAKE_NO_HIDDEN_LABELS && has("--show-hidden-labels")) {
  process.stderr.write("Usage: jmp get exporters [OPTIONS]\nError: No such option: --show-hidden-labels\n");
  process.exit(2);
}

if (process.env.JMP_FAKE_LEGACY_DRIVERS && startsWith("describe", "lease") && has("--drivers")) {
  process.stderr.write("Error: No such option: --drivers\n");
  process.exit(2);
}

const ENDPOINT = "grpc.fake.test:443";

const exporters = {
  exporters: [
    {
      namespace: "lab",
      name: "bench-1",
      labels: { board: "rpi4", site: "lab" },
      deprecated_labels: {},
      online: true,
      status: "AVAILABLE",
      lease: null,
    },
    {
      namespace: "lab",
      name: "bench-offline",
      labels: { board: "rpi4" },
      deprecated_labels: {},
      online: false,
      status: "OFFLINE",
      lease: null,
    },
    {
      namespace: "lab",
      name: "pool-member-1",
      labels: {
        board: "qemu",
        "exporterset.jumpstarter.dev/name": "qemu-pool",
        "exporterset.jumpstarter.dev/class": "qemu",
        "exporterset.jumpstarter.dev/provisioner": "qemu.jumpstarter.dev",
      },
      deprecated_labels: {},
      online: true,
      status: "AVAILABLE",
      lease: null,
    },
    {
      namespace: "lab",
      name: "registered-local",
      labels: { board: "mock" },
      deprecated_labels: {},
      online: true,
      status: "AVAILABLE",
      lease: null,
    },
  ],
};

const lease = {
  name: "lease-1",
  namespace: "lab",
  selector: "board=rpi4",
  exporter: "lab/bench-1",
  exporter_name: "bench-1",
  client: "fake",
  duration: 3600,
  effective_begin_time: "2026-01-01T00:00:00Z",
  effective_end_time: null,
  begin_time: "2026-01-01T00:00:00Z",
  tags: { "created-by": "vscode" },
  context: {},
  conditions: [],
  status: "In-Use",
};

const adminMeta = (name, labels) => ({
  name,
  namespace: valueOf("-n") ?? "default",
  labels,
  creationTimestamp: "2026-01-01T00:00:00Z",
  uid: `uid-${name}`,
});

const responses = [
  // `jmp mcp --help` answers where jumpstarter-mcp is installed beside the CLI
  [() => startsWith("mcp", "--help"), { usage: "jmp mcp [OPTIONS] COMMAND [ARGS]..." }],
  [() => startsWith("version"), { gitVersion: "0.10.0.dev53+gca3b4831", pythonVersion: "3.12.0 (fake)" }],

  [
    () => startsWith("config", "client", "list"),
    {
      currentConfig: "fake",
      items: [
        {
          alias: "fake",
          path: configFile(
            "clients",
            "fake",
            "apiVersion: jumpstarter.dev/v1alpha1\nkind: ClientConfig\nmetadata:\n  name: fake\n",
          ),
          endpoint: ENDPOINT,
          metadata: { name: "fake", namespace: "lab" },
        },
        {
          // A second config, so switching the current client is meaningful.
          alias: "spare",
          path: configFile(
            "clients",
            "spare",
            "apiVersion: jumpstarter.dev/v1alpha1\nkind: ClientConfig\nmetadata:\n  name: spare\n",
          ),
          endpoint: ENDPOINT,
          metadata: { name: "spare", namespace: "lab" },
        },
      ],
    },
  ],

  [
    () => startsWith("config", "exporter", "list"),
    {
      items: [
        {
          alias: "registered-local",
          path: configFile(
            "exporters",
            "registered-local",
            "apiVersion: jumpstarter.dev/v1alpha1\nkind: ExporterConfig\nmetadata:\n  name: registered-local\n",
          ),
          metadata: { name: "registered-local", namespace: "lab" },
        },
        {
          alias: "devbench",
          path: configFile(
            "exporters",
            "devbench",
            "apiVersion: jumpstarter.dev/v1alpha1\nkind: ExporterConfig\nmetadata:\n  name: devbench\n",
          ),
          metadata: { name: "devbench", namespace: "lab" },
        },
      ],
    },
  ],

  [
    () => startsWith("auth", "status") && process.env.JMP_FAKE_AUTH === "expired",
    {
      status: "expired",
      expiresAt: "2020-01-01T00:00:00Z",
      remainingSeconds: -1,
      subject: "client:lab:fake:0000",
      issuer: "https://localhost:8085",
      authTime: null,
      refreshTokenStored: false,
    },
  ],

  [
    () => startsWith("auth", "status"),
    {
      status: "valid",
      expiresAt: "2099-01-01T00:00:00Z",
      remainingSeconds: 9_999_999,
      // An API key the controller issued: a JWT, so it has an issuer, but no
      // refresh token and no auth_time. Nothing here may read as OIDC.
      subject: "client:lab:fake:0000",
      issuer: "https://localhost:8085",
      authTime: null,
      refreshTokenStored: false,
    },
  ],

  // `--with ports` alone is what the Leases view asks, for the direction of a lease's forwards.
  [
    () => startsWith("get", "exporters") && (valueOf("--with") ?? "").split(",").includes("ports"),
    fixture("exporters-ports.json"),
  ],
  // The controller is configured to hide the labels that name an exporter's set, as a lab's usually is:
  // they are in the answer only when asked for.
  [() => startsWith("get", "exporters") && has("--show-hidden-labels"), exporters],
  [
    () => startsWith("get", "exporters"),
    {
      exporters: exporters.exporters.map((exporter) => ({
        ...exporter,
        labels: Object.fromEntries(
          Object.entries(exporter.labels).filter(([key]) => !key.startsWith("exporterset.jumpstarter.dev/")),
        ),
      })),
    },
  ],
  // JMP_FAKE_MEMBERS adds the leases with members of the real CLI's output to the one lease of one exporter:
  // the suites that are about that one lease do not have to tell them apart.
  [
    () => startsWith("get", "leases"),
    { leases: [lease, ...(process.env.JMP_FAKE_MEMBERS ? fixture("leases.json").leases : [])] },
  ],
  [() => startsWith("get", "lease-templates"), fixture("lease-templates.json")],
  [() => startsWith("describe", "lease-template"), fixture("lease-template.json")],
  [() => startsWith("driver", "list"), { drivers: [] }],
  [() => startsWith("driver", "schema"), { drivers: [] }],

  [
    () => startsWith("admin", "get", "client"),
    {
      apiVersion: "jumpstarter.dev/v1alpha1",
      kind: "ClientList",
      items: [
        {
          metadata: adminMeta("fake", { team: "platform" }),
          status: { endpoint: ENDPOINT, credential: { name: "fake-client" } },
        },
        { metadata: adminMeta("no-credentials"), status: null },
      ],
    },
  ],

  [
    () => startsWith("admin", "get", "exporter"),
    {
      apiVersion: "jumpstarter.dev/v1alpha1",
      kind: "ExporterList",
      items: [
        {
          metadata: adminMeta("bench-1", { board: "rpi4" }),
          status: {
            endpoint: ENDPOINT,
            credential: { name: "bench-1-exporter" },
            devices: [{ uuid: "device-1", labels: {} }],
            exporterStatus: "Available",
            statusMessage: "Available for new lease",
          },
        },
        { metadata: adminMeta("bench-offline", { board: "rpi4" }), status: null },
      ],
    },
  ],

  [
    () => startsWith("admin", "get", "lease"),
    {
      apiVersion: "jumpstarter.dev/v1alpha1",
      kind: "LeaseList",
      items: [
        {
          metadata: adminMeta("lease-1"),
          spec: { client: { name: "fake" }, duration: "1h" },
          status: { exporter: { name: "bench-1" }, beginTime: "2026-01-01T00:00:00Z", ended: false },
        },
        {
          metadata: adminMeta("lease-old"),
          spec: { client: { name: "fake" }, duration: "1h" },
          status: { ended: true, endTime: "2026-01-01T01:00:00Z" },
        },
      ],
    },
  ],

  [
    () => startsWith("admin", "get", "exporterset"),
    {
      apiVersion: "jumpstarter.dev/v1alpha1",
      kind: "ExporterSetList",
      items: [
        {
          metadata: adminMeta("qemu-pool"),
          spec: {
            virtualTargetClassName: "qemu",
            provisioner: "qemu.jumpstarter.dev",
            minReplicas: 0,
            maxReplicas: 4,
            minAvailableReplicas: 1,
            selector: { board: "qemu" },
          },
          status: { replicas: 1, readyReplicas: 1, availableReplicas: 1, leasedReplicas: 0 },
          exporters: [{ name: "pool-member-1", labels: { board: "qemu" } }],
        },
      ],
    },
  ],

  [
    () => startsWith("admin", "apply"),
    {
      apiVersion: "jumpstarter.dev/v1alpha1",
      kind: "List",
      items: [
        {
          apiVersion: "jumpstarter.dev/v1alpha1",
          kind: "Client",
          name: "drafted",
          namespace: valueOf("-n") ?? "default",
          action: "created",
          resource: { apiVersion: "jumpstarter.dev/v1alpha1", kind: "Client" },
        },
      ],
    },
  ],
];

function respond() {
  // `admin import` writes a config and prints only where it wrote it.
  if (startsWith("admin", "import")) {
    const kind = argv[2];
    const name = argv[3];
    const dir = join(tmpdir(), "jumpstarter-fake", `${kind}s`);
    mkdirSync(dir, { recursive: true });
    const file = valueOf("--out") ?? join(dir, `${name}.yaml`);
    writeFileSync(
      file,
      `apiVersion: jumpstarter.dev/v1alpha1\nkind: ${kind === "client" ? "ClientConfig" : "ExporterConfig"}\nmetadata:\n  name: ${name}\n`,
    );
    process.stdout.write(`${file}\n`);
    return true;
  }

  // The drivers of the roles of a lease with members are read inside its
  // session, by a script (`jmp shell --lease L -- python -c ...`): answer
  // with what that script printed against real driver sessions.
  if (startsWith("shell") && has("--", "-c") && argv.some((arg) => arg.includes("lease_members_from_env"))) {
    process.stdout.write(fixtureText("role-drivers.txt"));
    return true;
  }

  // The real CLI refuses to describe the drivers of a lease with members.
  if (startsWith("describe", "lease") && has("--drivers") && /^lease-(9m2qd|degraded|omitted|pending)$/.test(argv[2] ?? "")) {
    process.stderr.write(
      `Error: lease ${argv[2]} has members (phone, headunit), not one exporter: request it with a LeaseMembers class, or call env_members() in its shell\n`,
    );
    process.exit(1);
  }

  // Creating a lease answers with the new lease's name.
  if (startsWith("create", "lease")) {
    process.stdout.write("lease-new\n");
    return true;
  }

  if (startsWith("delete", "leases") || startsWith("update", "lease")) {
    process.stdout.write("ok\n");
    return true;
  }

  if (startsWith("config", "client", "use") || startsWith("config", "client", "delete")) {
    process.stdout.write("ok\n");
    return true;
  }

  // `describe lease --drivers` is what the driver tree is built from: the
  // drivers in the session, and the `j` command tree they expose.
  if (startsWith("describe", "lease") && (has("--drivers") ||
      (process.env.JMP_FAKE_LEGACY_DRIVERS && has("--devices")))) {
    process.stdout.write(
      JSON.stringify({
        lease,
        [has("--drivers") ? "driver_tree" : "devices"]: {
          drivers: [
            {
              path: "power",
              driver_path: ["power"],
              class: "jumpstarter_driver_power.client.PowerClient",
              description: "Mock power control",
              methods: ["on", "off", "cycle"],
            },
            {
              path: "storage",
              driver_path: ["storage"],
              class: "jumpstarter.client.flasher.FlasherClient",
              description: "Flash the device",
              methods: ["flash"],
            },
          ],
          cli_tree: {
            name: "j",
            help: "Jumpstarter device CLI",
            params: [],
            subcommands: {
              power: {
                name: "power",
                help: "Power control",
                params: [],
                subcommands: {
                  on: { name: "on", help: "Power on", params: [], subcommands: {} },
                  off: { name: "off", help: "Power off", params: [], subcommands: {} },
                },
              },
              storage: {
                name: "storage",
                help: "Storage",
                params: [],
                subcommands: {
                  flash: {
                    name: "flash",
                    help: "Flash an image",
                    // A required argument, so running it has to prompt first.
                    params: [
                      {
                        name: "source",
                        kind: "argument",
                        type: "text",
                        help: "Image to flash",
                        required: true,
                        default: null,
                        opts: ["source"],
                      },
                    ],
                    subcommands: {},
                  },
                },
              },
            },
          },
        },
      }),
    );
    return true;
  }

  if (startsWith("describe")) {
    process.stdout.write(JSON.stringify({ name: argv[2] ?? "", kind: argv[1] ?? "" }));
    return true;
  }

  // Creating a client config from a token, and the config-file commands the
  // Clients view drives.
  if (startsWith("config", "client", "create")) {
    const alias = argv[3];
    configFile(
      "clients",
      alias,
      `apiVersion: jumpstarter.dev/v1alpha1\nkind: ClientConfig\nmetadata:\n  name: ${alias}\n`,
    );
    process.stdout.write("ok\n");
    return true;
  }

  for (const [matches, body] of responses) {
    if (matches()) {
      process.stdout.write(JSON.stringify(body));
      return true;
    }
  }
  return false;
}

// `jmp shell ... -- jumpstarter-web serve ...`: the one long-running thing the
// extension spawns itself. Announce an address the way the real server does
// and stay up until told to stop. JMP_FAKE_WEB=missing models an environment
// without the package.
if (startsWith("shell") && has("--", "serve")) {
  if (process.env.JMP_FAKE_WEB === "missing") {
    process.stderr.write("/usr/bin/python: No module named jumpstarter_web\n");
    process.exit(1);
  }
  const publicUrl = valueOf("--public-url");
  const base = publicUrl ?? `http://127.0.0.1:${valueOf("--port")}`;
  process.stdout.write(`jumpstarter-web: ${base}/${publicUrl ? "?token=fake-token" : ""}\n`);
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else if (!respond()) {
  process.stderr.write(`Error: fake jmp does not know '${argv.join(" ")}'\n`);
  process.exit(2);
}

// Prove the extension tolerates chatter on stderr: the real CLI logs there,
// and anything it writes must never be parsed as data.
if (has("-o", "json")) {
  process.stderr.write("INFO fake jmp: this line must not reach the parser\n");
}
