/**
 * Test-run lease pinning ("pytest-in-a-lease").
 *
 * WHY: hardware tests written with the JumpstarterTest pytest fixture acquire
 * a lease per run and release it afterwards — slow, and it can hand "your"
 * board to someone else between runs. The jumpstarter client library has an
 * escape hatch: when the JMP_LEASE environment variable names an existing
 * lease, `ClientConfigV1Alpha1.lease()` ATTACHES to that lease instead of
 * creating one, and does NOT release it on exit. Pinning a lease here exports
 * that variable for the whole workspace.
 *
 * HOW: `jumpstarter.pinLeaseForTests` stores {clientAlias, leaseName} in
 * workspaceState and applies it via
 * `context.environmentVariableCollection.replace()` for JMP_LEASE and
 * JMP_CLIENT (with a description explaining the injection). VS Code applies
 * that collection to every NEWLY created terminal, and current builds of the
 * ms-python extension also apply it to test runs — so pytest started from the
 * Test Explorer inherits the pin. JMP_CLIENT is exported alongside for
 * scripts/wrappers (`jmp shell --client "$JMP_CLIENT" --lease "$JMP_LEASE"`);
 * the CLI itself does not read it yet.
 *
 * FALLBACK: if the user's Python extension version does not apply env
 * collections to test runs, they can create a .env file containing
 * `JMP_LEASE=<name>` and point `"python.envFile"` at it — see
 * src/features/testing/README.md for the copy-pasteable recipe.
 *
 * LIFECYCLE: the pin persists in workspaceState and is re-applied on
 * activation; it is then validated in the background (only when jmp is
 * available and auth is usable — never triggering an interactive login) and
 * cleared with a notification when the lease is positively gone/ended.
 * `jumpstarter.clearTestPin` removes it; the "Tests → lease <short>" status
 * bar entry opens a switch/clear picker (`jumpstarter.manageTestPin`).
 */

import * as vscode from "vscode";
import { JmpError, Services } from "../services";
import { Lease } from "../types";
import {
  buildLeasePickEntries,
  coercePinArgument,
  decideRestoredPin,
  ENV_CLIENT_VAR,
  ENV_COLLECTION_DESCRIPTION,
  ENV_LEASE_VAR,
  makePin,
  parseStoredPin,
  PIN_STATE_KEY,
  pinEnvironment,
  pinStatusBarText,
  pinStatusBarTooltip,
  RestoreCheck,
  TestPin,
} from "./testing/pinModel";

const AUTH_BLOCKED = new Set(["expired", "no-token", "invalid-token"]);

export function registerTesting(context: vscode.ExtensionContext, services: Services): void {
  const feature = new TestingFeature(context, services);
  context.subscriptions.push(feature);

  context.subscriptions.push(
    vscode.commands.registerCommand("jumpstarter.pinLeaseForTests", (arg?: unknown) =>
      feature.pinLeaseForTests(arg),
    ),
    vscode.commands.registerCommand("jumpstarter.clearTestPin", () => feature.clearTestPin()),
    vscode.commands.registerCommand("jumpstarter.manageTestPin", () => feature.manageTestPin()),
  );

  feature.restore();
}

class TestingFeature implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private validated = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: Services,
  ) {
    this.statusItem = vscode.window.createStatusBarItem(
      "jumpstarter.testPin",
      vscode.StatusBarAlignment.Left,
      90,
    );
    this.statusItem.name = "Jumpstarter Test Pin";
    this.statusItem.command = "jumpstarter.manageTestPin";
    this.disposables.push(this.statusItem);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Pin state
  // -------------------------------------------------------------------------

  private getPin(): TestPin | null {
    return parseStoredPin(this.context.workspaceState.get(PIN_STATE_KEY));
  }

  private async setPin(pin: TestPin): Promise<void> {
    await this.context.workspaceState.update(PIN_STATE_KEY, pin);
    this.applyPin(pin);
  }

  /** Apply env collection + status bar for a pin (idempotent). */
  private applyPin(pin: TestPin): void {
    const collection = this.context.environmentVariableCollection;
    collection.description = ENV_COLLECTION_DESCRIPTION;
    for (const { name, value } of pinEnvironment(pin)) {
      collection.replace(name, value);
    }
    this.statusItem.text = pinStatusBarText(pin);
    this.statusItem.tooltip = pinStatusBarTooltip(pin);
    this.statusItem.show();
    this.services.output.appendLine(
      `[testing] pinned lease ${pin.leaseName} (client ${pin.clientAlias}) for test runs`,
    );
  }

  private async removePin(): Promise<void> {
    await this.context.workspaceState.update(PIN_STATE_KEY, undefined);
    const collection = this.context.environmentVariableCollection;
    // delete() only our two variables — never clear() the whole collection,
    // in case another feature contributes variables to it.
    collection.delete(ENV_LEASE_VAR);
    collection.delete(ENV_CLIENT_VAR);
    this.statusItem.hide();
    this.services.output.appendLine("[testing] test-run lease pin cleared");
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async pinLeaseForTests(arg?: unknown): Promise<void> {
    const coerced = coercePinArgument(arg);
    try {
      const clientAlias = coerced.clientAlias ?? (await this.resolveClientAlias());
      if (!clientAlias) {
        return; // user cancelled or an actionable message was already shown
      }
      const leaseName = coerced.leaseName ?? (await this.pickLease(clientAlias));
      if (!leaseName) {
        return;
      }
      await this.setPin(makePin(clientAlias, leaseName));
      void vscode.window.showInformationMessage(
        `Jumpstarter: test runs pinned to lease ${leaseName}. ` +
          "New terminals and test runs will attach to it (JMP_LEASE); already-open terminals are unaffected.",
      );
    } catch (err) {
      this.showCommandError("Pin lease for tests", err);
    }
  }

  async clearTestPin(): Promise<void> {
    const pin = this.getPin();
    await this.removePin();
    if (pin) {
      void vscode.window.showInformationMessage(
        `Jumpstarter: cleared test pin on lease ${pin.leaseName}. The lease itself is still active — delete it from the Leases view when done.`,
      );
    }
  }

  /** Status-bar click: offer switch/clear (or start a pin when none exists). */
  async manageTestPin(): Promise<void> {
    const pin = this.getPin();
    if (!pin) {
      await this.pinLeaseForTests();
      return;
    }
    const switchItem: vscode.QuickPickItem = {
      label: "$(arrow-swap) Switch pinned lease…",
      description: `currently ${pin.leaseName}`,
    };
    const clearItem: vscode.QuickPickItem = {
      label: "$(clear-all) Clear test pin",
      description: "test runs go back to acquiring their own leases",
    };
    const choice = await vscode.window.showQuickPick([switchItem, clearItem], {
      title: `Jumpstarter test pin — lease ${pin.leaseName} (client ${pin.clientAlias})`,
    });
    if (choice === switchItem) {
      await this.pinLeaseForTests();
    } else if (choice === clearItem) {
      await this.clearTestPin();
    }
  }

  // -------------------------------------------------------------------------
  // Restore + validation
  // -------------------------------------------------------------------------

  /** Re-apply a persisted pin on activation, then validate it when possible. */
  restore(): void {
    const pin = this.getPin();
    if (!pin) {
      // Defensive: drop stale env vars from a previous session whose pin was
      // cleared abnormally (workspaceState and the collection both persist).
      const collection = this.context.environmentVariableCollection;
      collection.delete(ENV_LEASE_VAR);
      collection.delete(ENV_CLIENT_VAR);
      return;
    }
    this.applyPin(pin);

    const availability = this.services.jmp.getAvailability();
    if (availability?.kind === "ok") {
      void this.validateRestoredPin(pin);
    } else {
      // Validate once jmp becomes available (interpreter picked later, etc.).
      this.disposables.push(
        this.services.jmp.onDidChangeAvailability((a) => {
          if (a.kind === "ok" && !this.validated) {
            void this.validateRestoredPin(pin);
          }
        }),
      );
    }
  }

  private async validateRestoredPin(pin: TestPin): Promise<void> {
    if (this.validated) {
      return;
    }
    this.validated = true;
    const check = await this.checkPin(pin);
    // The pin may have been changed/cleared by the user while we were checking.
    const current = this.getPin();
    if (!current || current.leaseName !== pin.leaseName || current.clientAlias !== pin.clientAlias) {
      return;
    }
    const decision = decideRestoredPin(pin, check);
    if (decision.action === "clear") {
      await this.removePin();
      void vscode.window.showWarningMessage(
        `Jumpstarter: cleared the test-run lease pin — ${decision.reason}. Test runs will acquire their own leases again.`,
      );
    } else {
      this.services.output.appendLine(
        `[testing] restored pin on lease ${pin.leaseName} (client ${pin.clientAlias})`,
      );
    }
  }

  /** Gather facts about a pin without ever triggering an interactive login. */
  private async checkPin(pin: TestPin): Promise<RestoreCheck> {
    try {
      const auth = await this.services.jmp.authStatus(pin.clientAlias);
      if (AUTH_BLOCKED.has(auth.status)) {
        return { kind: "auth-blocked", status: auth.status };
      }
      // includeEnded so a finished lease is positively identified (vs missing).
      const leases = await this.services.jmp.getLeases(pin.clientAlias, true);
      return { kind: "leases", leases };
    } catch (err) {
      const kind = err instanceof JmpError ? err.kind : "unknown";
      const message = err instanceof Error ? err.message : String(err);
      this.services.output.appendLine(`[testing] pin validation failed (${kind}): ${message}`);
      return { kind: "error", errorKind: kind, message };
    }
  }

  // -------------------------------------------------------------------------
  // Pickers
  // -------------------------------------------------------------------------

  /** Resolve which client alias to pin under; undefined = cancelled/none. */
  private async resolveClientAlias(): Promise<string | undefined> {
    const list = await this.services.jmp.listClients();
    if (list.items.length === 0) {
      void vscode.window.showErrorMessage(
        "Jumpstarter: no client configurations found — log in first (jmp login).",
      );
      return undefined;
    }
    if (list.items.length === 1) {
      return list.items[0].alias;
    }
    const picks = list.items.map((item) => ({
      label: item.alias,
      description: item.endpoint,
      picked: item.alias === list.currentConfig,
    }));
    // Current client first so Enter does the obvious thing.
    picks.sort((a, b) => Number(b.picked) - Number(a.picked));
    const choice = await vscode.window.showQuickPick(picks, {
      title: "Pin lease for tests — choose client",
      placeHolder: "Client configuration the lease belongs to",
    });
    return choice?.label;
  }

  /** Pick an active lease on the client; undefined = cancelled/none. */
  private async pickLease(clientAlias: string): Promise<string | undefined> {
    // Guard: an expired token would turn getLeases into an interactive
    // browser flow that hangs — ensureAuthValid throws "auth-expired" instead.
    await this.services.jmp.ensureAuthValid(clientAlias);
    const leases: Lease[] = await this.services.jmp.getLeases(clientAlias);
    const entries = buildLeasePickEntries(leases, this.getPin()?.leaseName);
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(
        `Jumpstarter: no active leases on client ${clientAlias} — create a lease first, then pin it.`,
      );
      return undefined;
    }
    const items = entries.map((entry) => ({
      label: entry.picked ? `$(pinned) ${entry.label}` : entry.label,
      description: entry.description,
      leaseName: entry.leaseName,
    }));
    const choice = await vscode.window.showQuickPick(items, {
      title: `Pin lease for tests — client ${clientAlias}`,
      placeHolder: "Lease that pytest/test runs should attach to",
    });
    return choice?.leaseName;
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  private showCommandError(what: string, err: unknown): void {
    if (err instanceof JmpError && err.kind === "auth-expired") {
      void vscode.window
        .showErrorMessage(
          `Jumpstarter: ${what} failed — authentication expired. Re-authenticate, then retry.`,
          "Show Output",
        )
        .then((action) => {
          if (action === "Show Output") {
            this.services.output.show();
          }
        });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.services.output.appendLine(`[testing] ${what} failed: ${message}`);
    void vscode.window.showErrorMessage(`Jumpstarter: ${what} failed — ${message}`);
  }
}
