import * as vscode from "vscode";
import { JmpService } from "./services/jmpService";
import { ConfigWatcher } from "./services/configWatcher";
import { StatusBarManager } from "./services/statusBar";
import { Poller, PollerOptions } from "./services/poller";
import { Services } from "./services";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Jumpstarter");
  context.subscriptions.push(output);

  const jmp = new JmpService(output);
  const configWatcher = new ConfigWatcher();
  const statusBar = new StatusBarManager(jmp);
  context.subscriptions.push(jmp, configWatcher, statusBar);

  const services: Services = {
    jmp,
    configWatcher,
    statusBar,
    output,
    createPoller: (options: PollerOptions) => new Poller(options),
  };

  // Base wiring: keep the status bar in sync with config changes, interpreter
  // switches and availability probes.
  context.subscriptions.push(
    configWatcher.onDidChangeConfig(() => void statusBar.refresh()),
    jmp.onDidChangeAvailability(() => void statusBar.refresh()),
    vscode.commands.registerCommand("jumpstarter.refresh", async () => {
      await jmp.probe();
      await statusBar.refresh();
    }),
  );

  // Resolve the Python interpreter, hook environment-change events and run
  // the initial `jmp version` probe (fires onDidChangeAvailability).
  await jmp.initialize();

  // -------------------------------------------------------------------------
  // Feature registration points.
  //
  // Each feature module lives in src/features/<name>.ts and exports
  //   export function register<Feature>(context, services): void
  // Import it at the top of this file and call it here.
  // -------------------------------------------------------------------------

  // FEATURE REGISTRATION: clients (tree view jumpstarter.clients)
  // import { registerClients } from "./features/clients";
  // registerClients(context, services);

  // FEATURE REGISTRATION: exporters (tree view jumpstarter.exporters)
  // import { registerExporters } from "./features/exporters";
  // registerExporters(context, services);

  // FEATURE REGISTRATION: leases (tree view jumpstarter.leases)
  // import { registerLeases } from "./features/leases";
  // registerLeases(context, services);

  // FEATURE REGISTRATION: shell / lease terminals
  // import { registerShell } from "./features/shell";
  // registerShell(context, services);

  // FEATURE REGISTRATION: auth / login flows
  // import { registerAuth } from "./features/auth";
  // registerAuth(context, services);

  void services; // referenced by the feature registrations above
}

export function deactivate(): void {}
