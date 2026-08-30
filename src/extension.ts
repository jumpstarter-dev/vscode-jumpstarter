import * as vscode from "vscode";
import { JmpService } from "./services/jmpService";
import { ConfigWatcher } from "./services/configWatcher";
import { StatusBarManager } from "./services/statusBar";
import { Poller, PollerOptions } from "./services/poller";
import { Services } from "./services";
import { registerDetails } from "./features/details";
import { registerClients } from "./features/clients";
import { registerExporters } from "./features/exporters";
import { registerLeases } from "./features/leases";
import { registerTesting } from "./features/testing";
import { registerSchemas } from "./features/schemas";
import { registerAdmin, resolveAdminOptions } from "./features/admin";
import { registerManifests } from "./features/manifests";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Jumpstarter");
  context.subscriptions.push(output);

  const jmp = new JmpService(output);
  const configWatcher = new ConfigWatcher();
  const statusBar = new StatusBarManager(jmp);
  context.subscriptions.push(jmp, configWatcher, statusBar);

  const leaseChangeEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(leaseChangeEmitter);

  const services: Services = {
    jmp,
    configWatcher,
    statusBar,
    output,
    onDidChangeLeases: leaseChangeEmitter.event,
    notifyLeasesChanged: () => leaseChangeEmitter.fire(),
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

  // -------------------------------------------------------------------------
  // Feature registration points.
  //
  // Each feature module lives in src/features/<name>.ts and exports
  //   export function register<Feature>(context, services): void
  // Import it at the top of this file and call it here.
  // -------------------------------------------------------------------------

  // FEATURE REGISTRATION: details (webview jumpstarter.details) — registered
  // first so the trees can push their initial selection into it
  registerDetails(context);

  // FEATURE REGISTRATION: clients (tree view jumpstarter.clients, auth flows,
  // add-client wizard, status bar quick pick)
  registerClients(context, services);

  // FEATURE REGISTRATION: exporters (tree view jumpstarter.exporters, lease
  // acquisition by exporter or label selector)
  registerExporters(context, services);

  // FEATURE REGISTRATION: leases (tree view jumpstarter.leases, device tree,
  // shell / run-in-lease terminals, extend/end lease)
  registerLeases(context, services);

  // FEATURE REGISTRATION: testing (pin a lease for test runs via JMP_LEASE)
  registerTesting(context, services);

  // FEATURE REGISTRATION: schemas (YAML schema association + config scaffolds)
  registerSchemas(context, services);

  // FEATURE REGISTRATION: manifests (new-resource wizards, apply a manifest to
  // the cluster, import a client/exporter config the cluster issued)
  registerManifests(context, services, () => resolveAdminOptions(services));

  // FEATURE REGISTRATION: admin (tree view jumpstarter.admin — every client,
  // exporter, set and lease in a namespace; hidden without a usable kubeconfig)
  registerAdmin(context, services);

  // Resolve the Python interpreter, hook environment-change events and run
  // the initial `jmp version` probe (fires onDidChangeAvailability). NOT
  // awaited: registration above must not wait on a slow/hanging probe —
  // commands and views must exist immediately, and every feature re-renders
  // on onDidChangeAvailability once the probe completes.
  void jmp.initialize();
}

export function deactivate(): void {}
