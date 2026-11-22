#!/usr/bin/env node
/**
 * A stand-in for the `jumpstarter-web` CLI, for the integration tests.
 *
 * Only `plugins -o json` is answered here: it is the one thing the extension
 * runs directly. `serve` is always started through `jmp shell -- …`, so the
 * fake jmp answers that. The plugins match the drivers the fake jmp reports.
 */

const argv = process.argv.slice(2);

if (argv[0] === "plugins" && argv.includes("json")) {
  process.stdout.write(
    JSON.stringify({
      plugins: [
        {
          id: "power",
          title: "Power",
          compatible: true,
          views: [
            { id: "power/meter", type: "main", title: "Meter", matches: ["jumpstarter_driver_power.client.PowerClient"] },
            { id: "power/panel", type: "sidebar", title: "Power", matches: ["jumpstarter_driver_power.client.PowerClient"] },
          ],
        },
        {
          id: "broken",
          title: "Broken",
          compatible: false,
          views: [{ id: "broken/view", type: "main", title: "Broken", matches: ["jumpstarter.client.flasher.FlasherClient"] }],
        },
      ],
    }),
  );
} else {
  process.stderr.write(`Error: fake jumpstarter-web does not know '${argv.join(" ")}'\n`);
  process.exit(2);
}
