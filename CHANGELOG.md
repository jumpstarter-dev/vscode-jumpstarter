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
- **Details** view: selecting a client, exporter or lease shows its full
  detail, rendered from data the trees already hold (no extra CLI calls). It
  ships collapsed and expands on selection.
- Venv-aware IntelliSense for config files: an exporter config completes
  `type:` from the drivers installed in the active environment — with each
  driver's summary, package and config keys on hover — and completes and
  validates its `config:` block against that driver's own fields; a client
  config completes `drivers.allow` from the installed driver packages and
  their client classes.
- Driver commands prompt for their parameters before running, using Click's
  own help text: required ones in order, then a multi-select of the optional
  ones, with pick lists for choices and validation for numbers.
- Edit buttons for client and exporter configs, escalating to `sudoedit` when
  the file belongs to another user.
- Inline hover actions: acquire a lease, set the current client, end a lease.
- Lease terminals start with the active virtual environment on `PATH`, so
  `python`, `pytest` and `j` inside a lease resolve to the environment `jmp`
  came from — and the Python extension stops typing an activation command
  into a shell that is already activated.
- The **Jumpstarter** output channel traces every CLI invocation with its
  redacted arguments, exit status, duration and payload size.

### Fixed

- Exporters with no reported status (older controllers) no longer break the
  view, and an absent `enabled` field is read as enabled rather than disabled.
- One-shot commands run in a terminal that stays open, so their output
  survives the command exiting.
- The device tree no longer lists the session's root composite as a device.
- YAML schemas are served under the URI scheme the YAML extension routes
  content requests for, fixing "Unable to load schema … No content".
