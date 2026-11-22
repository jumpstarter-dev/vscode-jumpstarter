import * as vscode from "vscode";
import { JmpService } from "./services/jmpService";
import { ConfigWatcher } from "./services/configWatcher";
import { StatusBarManager } from "./services/statusBar";
import { Poller, PollerOptions } from "./services/poller";
import { PendingLeaseStore, Services } from "./services";
import { initIconAssets } from "./features/icons";
import { registerDetails } from "./features/details";
import { registerClients } from "./features/clients";
import { registerExporters } from "./features/exporters";
import { registerLeases } from "./features/leases";
import { registerWebUi, WebUiApi } from "./features/webUi";
import { registerTesting } from "./features/testing";
import { registerSchemas } from "./features/schemas";
import { registerAdmin, resolveAdminOptions } from "./features/admin";
import { registerManifests } from "./features/manifests";

/**
 * What activate() resolves to.
 *
 * This exists for the integration tests: a TreeDataProvider is otherwise
 * unreachable from outside the module that registered it, and asserting on
 * what a view actually renders is the whole point of those tests. Nothing in
 * the extension consumes this.
 */
export interface JumpstarterApi {
  services: Services;
  /** The tree providers behind the four views, by view name. */
  trees: Record<"clients" | "exporters" | "leases" | "admin", vscode.TreeDataProvider<unknown>>;
  /** The Jumpstarter Web servers this window started. */
  webUi: WebUiApi;
  /** Re-read every view from the CLI and settle. */
  refreshAll(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): JumpstarterApi {
  const output = vscode.window.createOutputChannel("Jumpstarter");
  context.subscriptions.push(output);

  // Where the bundled state icons live; must run before any tree renders.
  initIconAssets(context.extensionUri);

  const jmp = new JmpService(output);
  const configWatcher = new ConfigWatcher();
  const statusBar = new StatusBarManager(jmp);
  context.subscriptions.push(jmp, configWatcher, statusBar);

  const leaseChangeEmitter = new vscode.EventEmitter<void>();
  const pendingLeases = new PendingLeaseStore();
  context.subscriptions.push(leaseChangeEmitter, pendingLeases);

  const services: Services = {
    jmp,
    configWatcher,
    statusBar,
    output,
    onDidChangeLeases: leaseChangeEmitter.event,
    notifyLeasesChanged: () => leaseChangeEmitter.fire(),
    pendingLeases,
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
  const clientsTree = registerClients(context, services);

  // FEATURE REGISTRATION: exporters (tree view jumpstarter.exporters, lease
  // acquisition by exporter or label selector)
  const exportersTree = registerExporters(context, services);

  // FEATURE REGISTRATION: leases (tree view jumpstarter.leases, driver tree,
  // shell / run-in-lease terminals, extend/end lease)
  const leasesTree = registerLeases(context, services);

  // FEATURE REGISTRATION: web UI (open a lease's screen and tools in
  // Jumpstarter Web, served from inside the lease session)
  const webUi = registerWebUi(context, services, leasesTree);

  // FEATURE REGISTRATION: testing (pin a lease for test runs via JMP_LEASE)
  registerTesting(context, services);

  // FEATURE REGISTRATION: schemas (YAML schema association + config scaffolds)
  registerSchemas(context, services);

  // FEATURE REGISTRATION: manifests (new-resource wizards, apply a manifest to
  // the cluster, import a client/exporter config the cluster issued)
  registerManifests(context, services, () => resolveAdminOptions(services));

  // FEATURE REGISTRATION: admin (tree view jumpstarter.admin — every client,
  // exporter, set and lease in a namespace; hidden without a usable kubeconfig)
  const adminTree = registerAdmin(context, services);

  // Resolve the Python interpreter, hook environment-change events and run
  // the initial `jmp version` probe (fires onDidChangeAvailability). NOT
  // awaited: registration above must not wait on a slow/hanging probe —
  // commands and views must exist immediately, and every feature re-renders
  // on onDidChangeAvailability once the probe completes.
  void jmp.initialize();

  return {
    services,
    webUi,
    trees: {
      clients: clientsTree,
      exporters: exportersTree,
      leases: leasesTree,
      admin: adminTree,
    },
    refreshAll: async () => {
      for (const command of [
        "jumpstarter.clients.refresh",
        "jumpstarter.exporters.refresh",
        "jumpstarter.leases.refresh",
        "jumpstarter.admin.refresh",
      ]) {
        await vscode.commands.executeCommand(command);
      }
    },
  };
}

export function deactivate(): void {}
