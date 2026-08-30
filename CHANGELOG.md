# Change Log

All notable changes to the "jumpstarter" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- Jumpstarter activity bar container with **Clients**, **Exporters** and
  **Leases** views, all driven by the `jmp` CLI resolved from the active
  Python environment (or `jumpstarter.jmpPath`).
- Clients: add-client wizard (OIDC login or API token), switch/current client,
  per-client auth status badges, re-authenticate in a terminal, open/delete
  client config; status bar item with a client quick pick.
- Exporters: live status view, filter by label selector, acquire a lease on an
  exporter or by selector with a live match count.
- Leases: remaining-time countdowns, open a shell in a lease, browse leased
  device drivers and run their CLI commands in a lease terminal, run the
  current file inside the lease, extend/release, copy `JMP_LEASE` export line,
  toggle ended leases. Extension-created leases are tagged
  `jumpstarter.dev/created-by=vscode`.
- Test pinning: pin a lease for test runs (exports `JMP_LEASE`/`JMP_CLIENT`
  via the environment variable collection so the `JumpstarterTest` pytest
  fixture attaches to your lease instead of acquiring/releasing its own), with
  a status bar indicator and workspace persistence.
- YAML schema validation/completion for Jumpstarter client, exporter and user
  configs (via the Red Hat YAML extension), plus **New Client Config** /
  **New Exporter Config** scaffolds.
- Settings: `jumpstarter.jmpPath`, `jumpstarter.pollIntervalSeconds`.
- Safety: polling pauses when views are hidden, backs off when the window is
  unfocused, and stops (with a re-authenticate action) when the client token
  expires; secret-bearing CLI arguments are redacted from logs and errors.
