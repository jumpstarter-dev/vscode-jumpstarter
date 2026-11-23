---
name: jumpstarter-robot-tests
description: Write, run and debug Robot Framework test suites that lease Jumpstarter devices and call their drivers through the jumpstarter_robot library. Use when the user asks for a .robot test or suite against a device, a phone, a head unit or several devices at once.
---

# Robot Framework suites on Jumpstarter devices

The `jumpstarter_robot` package is a Robot Framework library: a suite leases a device (or joins a lease that is
already there), and the device's drivers become keywords.

## One device

```robotframework
*** Settings ***
Library           jumpstarter_robot.Jumpstarter    selector=type=phone    duration=30 minutes
Suite Setup       Acquire Lease
Suite Teardown    Release Lease

*** Test Cases ***
The Phone Has Its Drivers
    ${drivers}=    List Drivers
    Should Not Be Empty    ${drivers}
```

* `selector` is a label selector, as in `jmp_create_lease` and `jmp get exporters`. Take it from the exporters
  that exist (`jmp_list_exporters`), not from a guess.
* `Acquire Lease` in the suite setup and `Release Lease` in the teardown, so a failed test still frees the device.
* Under an existing lease (`jmp shell`, or a lease pinned for test runs in the VS Code Jumpstarter view) the suite
  uses that lease instead of taking a new one.

## Finding the keywords

**Do not invent driver keywords.** They come from the drivers of the leased device and differ per device.

* In a suite: `List Drivers` returns the drivers, `List Driver Keywords` the keywords they give
  (`List Driver Keywords    path=power` for one driver).
* Before writing: connect to the device with the MCP tools (skill `jumpstarter-devices`) and read `jmp_tools`
  for the driver you need, to know what the driver can do; then take the keyword's exact name from
  `List Driver Keywords`.
* In VS Code, the Keywords view of RobotCode lists the library's keywords once the suite imports it.

Write a keyword into a suite only after one of these showed it.

## Several devices in one suite

Each device is a session with a name. The first comes from `jumpstarter_robot.Jumpstarter`, every further one from
`jumpstarter_robot.Session`:

```robotframework
*** Settings ***
Library           jumpstarter_robot.Jumpstarter    selector=type=phone    session=phone
Library           jumpstarter_robot.Session    headunit    selector=type=head-unit    AS    session.headunit
Suite Setup       Lease Both
Suite Teardown    Release Both

*** Keywords ***
Lease Both
    Acquire Lease    session=phone
    Acquire Lease    session=headunit

Release Both
    Release Lease    session=headunit
    Release Lease    session=phone

*** Test Cases ***
Both Devices Answer
    ${phone}=    List Drivers    session=phone
    ${headunit}=    List Drivers    session=headunit
```

Where a driver of the second session has the same name as one of the first, its keywords carry the session's name
in front; `List Driver Keywords    session=headunit` says what each is called.

## Running

* `robot --outputdir results tests/phone.robot` from a terminal, or the Testing view (RobotCode) in VS Code.
* A run leases real hardware for its duration. Ask before running a suite the user did not ask you to run, and
  keep `duration` no longer than the suite needs.
* To watch a run, the user opens the device's screen: "Open Screen" on the lease in the Jumpstarter view.
* When a keyword fails on the device, look at the device before changing the test: `jmp_screenshot` for the
  screen, the serial console (`jmp_run` with `["serial", "pipe"]` and a short `timeout_seconds`) for a board.
