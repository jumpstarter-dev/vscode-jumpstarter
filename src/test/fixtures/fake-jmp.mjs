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

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  tags: { "jumpstarter.dev/created-by": "vscode" },
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
  [() => startsWith("version"), { gitVersion: "v0.99.0-fake", pythonVersion: "3.12.0 (fake)" }],

  [
    () => startsWith("config", "client", "list"),
    {
      currentConfig: "fake",
      items: [
        {
          alias: "fake",
          path: join(tmpdir(), "jumpstarter-fake", "clients", "fake.yaml"),
          endpoint: ENDPOINT,
          metadata: { name: "fake", namespace: "lab" },
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
          path: join(tmpdir(), "jumpstarter-fake", "exporters", "registered-local.yaml"),
          metadata: { name: "registered-local", namespace: "lab" },
        },
        {
          alias: "devbench",
          path: join(tmpdir(), "jumpstarter-fake", "exporters", "devbench.yaml"),
          metadata: { name: "devbench", namespace: "lab" },
        },
      ],
    },
  ],

  [
    () => startsWith("auth", "status"),
    {
      status: "valid",
      expiresAt: "2099-01-01T00:00:00Z",
      remainingSeconds: 9_999_999,
      subject: "fake@example.test",
      issuer: "https://sso.example.test",
      refreshTokenStored: true,
    },
  ],

  [() => startsWith("get", "exporters"), exporters],
  [() => startsWith("get", "leases"), { leases: [lease] }],
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

  if (startsWith("describe")) {
    process.stdout.write(JSON.stringify({ name: argv[2] ?? "", kind: argv[1] ?? "" }));
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

if (!respond()) {
  process.stderr.write(`Error: fake jmp does not know '${argv.join(" ")}'\n`);
  process.exit(2);
}

// Prove the extension tolerates chatter on stderr: the real CLI logs there,
// and anything it writes must never be parsed as data.
if (has("-o", "json")) {
  process.stderr.write("INFO fake jmp: this line must not reach the parser\n");
}
