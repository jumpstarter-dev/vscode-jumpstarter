# Driver versus device terminology

Audit baseline: Jumpstarter `main` at `ca3b4831`. This is an inventory of
existing conventions and migration considerations, not a change to the
exporter device-report API.

## What the current report actually contains

`Driver.report()` creates a protobuf `DriverInstanceReport`; `Driver.enumerate()`
walks configured software driver instances, including composites. The session's
`GetReport` and exporter registration send these reports. The Python client
uses their UUIDs, parent UUIDs, and `jumpstarter.dev/client` / `jumpstarter.dev/name`
labels to construct the driver-client tree.

The controller then maps registration `reports` into `Exporter.status.devices`.
Consequently, that Kubernetes field is not a discovered physical-device inventory.
A composite, power interface, or other driver node is not necessarily a distinct
piece of hardware. Hardware-specific uses of “device” (USB, storage, etc.) are
separate and should not be mechanically renamed.

## Where the convention is entrenched

Paths below are relative to the Jumpstarter repository.

| Surface | Existing convention | Compatibility implications |
| --- | --- | --- |
| Protobuf | `DriverInstanceReport`, `RegisterRequest.reports`, `GetReportResponse.reports` in `protocol/proto/jumpstarter/v1/jumpstarter.proto` | Already describes driver instances. Client construction and driver RPC addressing depend on this report; do not replace it with hardware inventory. |
| Kubernetes API | `Device` and `Exporter.status.devices` in `controller/api/v1alpha1/` | Persisted JSON field, generated CRD schemas/install manifests, Go consumers and Python models. A rename needs a compatibility/migration plan. |
| Controller behavior | `controller/internal/service/controller_service.go` fills `status.devices` on registration and clears it on unregistration | `controller/internal/controller/exporter_controller.go` uses nil versus non-nil to set the Registered condition. Inventory semantics cannot silently replace this. |
| Python Kubernetes client | `V1Alpha1ExporterDevice`, `V1Alpha1ExporterStatus.devices` in `python/packages/jumpstarter-kubernetes/jumpstarter_kubernetes/exporters.py` | Published model names/JSON output, plus a `DEVICES` table column. Existing callers may depend on both. |
| Admin CLI | `jmp admin get exporter(s) --devices` in `python/packages/jumpstarter-cli-admin/jumpstarter_cli_admin/get.py` | Existing flag and output contract; leave intact pending a separate migration. |
| Python exporter/session | `device_factory`, `root_device`, and some driver enumeration docstrings | These actually refer to `Driver` objects. Keyword arguments and integrations may rely on the names even where they look internal. |
| MCP | General connection/tool descriptions say “device”, while driver discovery explicitly lists driver objects | Wording can be clarified separately; avoid confusing a hardware target with a driver instance. |
| New lease introspection | `jmp describe lease --drivers`, `{lease, driver_tree}`, Drivers/Commands headings | Establish accurate terminology before merging. No new `--devices` alias is introduced. |

## History

- [`ba5b6dd8`](https://github.com/jumpstarter-dev/jumpstarter/commit/ba5b6dd8)
  (2024-07-01): “Add devices field to exporter status”.
- [`44f44c43`](https://github.com/jumpstarter-dev/jumpstarter/commit/44f44c43)
  (2024-07-18): renamed protobuf `DeviceReport` to `DriverInstanceReport` and
  `device_report` to `reports`. The Kubernetes naming did not follow that rename.

## Safe future direction

1. Use **driver**, **driver instance**, and **driver tree** for software interfaces
   in new APIs and UI text.
2. Keep existing `status.devices`, admin `--devices`, and report semantics working
   until a separately reviewed migration is in place. Do not silently reinterpret
   their contents or change registration/readiness behavior.
3. Model actual attached hardware separately, including stable identity and its
   relationship to driver instances. A device-to-driver mapping need not be one-to-one.
4. If renaming persisted fields, plan old/new controller and client interoperability,
   schema updates, compatibility reads/writes, deprecation periods, and eventual
   removal. This cross-cutting change warrants a separate design/JEP.

## Extension compatibility

The lease tree uses driver terminology and consumes `{lease, driver_tree}`.
For older integration-branch CLIs only, an explicit “No such option: --drivers”
usage error permits retrying the legacy `--devices` API and normalizing its
`{lease, devices}` response. Session/authentication failures are not retried.
This remains experimental and disabled on current `main`.

Existing extension command IDs containing `Device`/`Devices` remain stable for
keybindings; visible labels say “Drivers”. The Administration view's existing
exporter device-report model is unchanged.
