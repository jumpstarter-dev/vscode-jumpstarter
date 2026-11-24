# CLI output fixtures

What the Jumpstarter CLI prints for leases with members (JEP-0015), lease
templates and port forwards (JEP-0016). The unit tests parse these files and
the fake `jmp` of the integration tests answers with them, so the extension is
tested against the shapes the CLI has.

They were made from the client models of the Jumpstarter branch
`feat/robot-multi-exporter`, with the protobuf builders its own tests use
(`jumpstarter/client/_members_testing.py`) and the serialization of
`jmp ... -o json` (`model_dump(mode="json", by_alias=True)`):

| File | Command it is the output of |
| --- | --- |
| `leases.json` | `jmp get leases -o json`: a lease from a template with a connected forward, a degraded one (a lost role, a failed forward), one with a role left out (a disabled forward), one still waiting, and a lease of one exporter |
| `lease-member.json` | `jmp get leases NAME -o json` / `jmp describe lease NAME -o json` of the first |
| `lease-templates.json` | `jmp get lease-templates -o json` |
| `lease-template.json` | `jmp describe lease-template ivi -o json` |
| `exporters-ports.json` | `jmp get exporters --with ports -o json` |
| `role-drivers.txt` | the script of `ROLE_DRIVERS_SCRIPT` (`src/services/leaseProtocol.ts`), run with two real driver sessions (a composite with a mock power driver each) served on sockets named in `JMP_LEASE_MEMBERS`, as `jmp shell` on a lease with members serves its roles |
