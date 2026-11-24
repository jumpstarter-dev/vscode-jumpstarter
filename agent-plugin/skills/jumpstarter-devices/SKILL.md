---
name: jumpstarter-devices
description: Lease and control hardware devices (boards, phones, head units, emulators) through Jumpstarter and its MCP tools (jmp_*). Use when the user wants to power, flash, reach over serial or SSH, see or tap the screen of, or otherwise drive a device, or asks about exporters, leases or drivers.
---

# Working with Jumpstarter devices

Jumpstarter gives remote access to devices. An **exporter** serves a device, a **lease** reserves it for one client
for a time, and a device's **drivers** (power, serial, storage, ssh, adb, a screen, Appium, ...) are what you call.
The `jmp_*` tools of the Jumpstarter MCP server do all of it with the user's own client configuration.

If no `jmp_*` tool is available, say so: the server is `jmp mcp serve` and needs the `jumpstarter-mcp` package beside
the `jmp` CLI. In VS Code the Jumpstarter extension registers it (setting `jumpstarter.mcp.enabled`).

## The order of work

1. **Find the device.** `jmp_list_leases` first: the user often holds a lease already (in VS Code it is in the
   Jumpstarter view, under Leases). Reuse it. Otherwise `jmp_list_exporters` shows what exists and its labels, and
   `jmp_create_lease` takes a label selector such as `type=phone` and a duration. Ask before leasing a device the
   user did not name: a lease takes the device from everyone else.
2. **Connect.** `jmp_connect` with the lease id returns a `connection_id` and the device's tools, by driver. Keep the
   connection for the whole task; do not reconnect per call.
3. **Learn the device before acting.** Devices differ. `jmp_tools(connection_id, driver)` gives one driver's tools
   and their arguments. Never assume a driver or a command exists.
4. **Use it.** `jmp_read` for tools that only read, `jmp_call` for the rest, by tool name. Every call names its
   `connection_id`: with two devices connected that is what says which one you act on.
5. **Watch for events.** `jmp_list_events` now and then: it carries lease expiry warnings and failures.
6. **Finish.** `jmp_disconnect`. Call `jmp_delete_lease` only for a lease you created in this task, never for one
   the user already had.

## Leases with members (several devices in one lease)

A lab administrator can publish **lease templates**: sets of devices that belong together (a head unit, its phone
and its ECU), each a **role**. One lease from a template holds an exporter for every role, and has no single
exporter of its own.

The `jmp_*` connection tools work on a lease of one exporter. For a lease with members use the CLI in a terminal:

* `jmp get lease-templates` lists the templates (a `*` marks an optional role) and
  `jmp describe lease-template NAME` shows one with its instructions.
* `jmp create lease -t NAME --duration 1h -o name` requests it; `--without ROLE` leaves an optional role out.
  Ask first, as for any lease.
* `jmp shell --lease LEASE -- j ROLE DRIVER ...` runs a driver command on one role (`j headunit power on`);
  `jmp shell --lease LEASE -- j --help` lists the roles and `jmp shell --lease LEASE -- j-forward status` the
  forwards between them.
* In Python, inside `jmp shell --lease LEASE`: `from jumpstarter.utils.env import env_members`, then
  `with env_members() as members: members.by_role["phone"]...`. `env()` is for a lease of one exporter.

A lease whose status is `Degraded` lost the exporter of one role; the other roles still work. In VS Code the
user sees the roles and forwards under the lease in the Jumpstarter view, and lease templates in their own view.

## Raw commands

`jmp_run` runs a `j` command line on the connection, as a list of arguments; `jmp_explore` lists what there is.
Use it for what is not one call:

* Power: `["power", "on"]`, `["power", "off"]`, `["power", "cycle"]`
* SSH: `["ssh", "--", "uname", "-a"]`
* Storage: `["storage", "flash", "/path/to/image"]`
* Serial: `["serial", "pipe"]` keeps streaming: give `timeout_seconds` of 10 to 15 so it returns what it captured.

Power off, power cycle and flash change the device: say what you are about to do when the user did not ask for it.

## Screens

`jmp_screenshot(connection_id)` returns a picture of the device's screen: use it to find what to tap and to check
the result of a step. Where the server has them, `jmp_show` brings a view forward for the user with your message
and marks a place on the screen, and `jmp_open_web` returns a URL of Jumpstarter Web for the lease.

In VS Code the user sees the device without you: "Open Screen" on the lease in the Jumpstarter view opens its
screen in a tab, and a driver with a view (Appium) has "Open View" on its row. Point the user there to watch.

## Scripts instead of calls

For many steps, or code the user will keep, `jmp_get_env(connection_id)` gives the environment variables and the
Python and `j` paths of the connection. `jmp_driver_methods` gives exact method signatures.

In Python examples for the user, always take the client from the session's environment:

```python
from jumpstarter.utils.env import env

with env() as client:
    client.power.cycle()
```

That runs under `jmp shell` (or with the variables from `jmp_get_env`). Do not write `ClientConfigV1Alpha1`,
`lease()` or `connect()` in examples: those are for standalone automation.

For a Robot Framework suite, use the `jumpstarter-robot-tests` skill.
