#!/usr/bin/env node
// Kept separate from fake-jmp so tests verify which executable was selected.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.JMP_FAKE_LOG) {
  appendFileSync(process.env.JMP_FAKE_LOG, `${JSON.stringify(["kubectl", ...args])}\n`);
}
if (process.env.JMP_FAKE_KUBECTL_FAIL) {
  process.stderr.write("Error from server (Forbidden): cannot apply the requested resources\n");
  process.exit(1);
}
if (args[0] !== "apply" || !args.includes("-f") || args.slice(-2).join(" ") !== "-o name") {
  process.stderr.write("unexpected kubectl arguments\n");
  process.exit(2);
}
process.stdout.write("client.jumpstarter.dev/drafted\n");
