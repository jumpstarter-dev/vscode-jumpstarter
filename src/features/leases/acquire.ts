/**
 * Asking for a lease, and showing the request until the lease can be used.
 *
 * `jmp create lease` answers as soon as the controller has made the lease,
 * which is before an exporter is bound to it: a pool with nothing warm has to
 * provision one first. The request is therefore shown in the lease views from
 * the moment it is made until the lease is held, has ended, or the time
 * allowed is over, whichever comes first, and the lease's own row is left out
 * meanwhile. Otherwise the row came, went when the command answered, and came
 * back when the lease was bound.
 */

import * as vscode from "vscode";
import { LeaseWaitOutcome, Services, waitForLease } from "../../services";
import { LEASE_WAIT_MS } from "../../services/pendingLeasesModel";

export interface AcquireRequest {
  client: string;
  /** What the request's row is called: the exporter, the exporter set or the template asked for. */
  label: string;
  /** "on cf-phone", "from template ivi": how the messages say what was asked for. */
  target: string;
  /** Makes the lease, and answers its name. */
  create: () => Promise<string>;
}

/** How long the Leases view is given to read the listing before the request's row goes anyway. */
const VIEW_READ_MS = 15_000;

async function leasesViewRead(): Promise<void> {
  try {
    await Promise.race([
      vscode.commands.executeCommand("jumpstarter.leases.refresh"),
      new Promise<void>((resolve) => setTimeout(resolve, VIEW_READ_MS)),
    ]);
  } catch {
    // (the view says what went wrong with its own refresh)
  }
}

/**
 * Makes a lease and waits for it to be held. Answers how that ended, or
 * `undefined` when the lease could not be made (which the caller says, in its
 * own words).
 */
export async function acquireLease(
  services: Services,
  request: AcquireRequest,
  onFailure: (message: string) => void,
): Promise<LeaseWaitOutcome | undefined> {
  const { client, label, target } = request;
  const pending = services.pendingLeases.begin(client, label);
  try {
    return await vscode.window.withProgress(
      // Progress shows in the Leases view: that is where the result appears.
      { location: { viewId: "jumpstarter.leases" }, title: `Acquiring lease ${target}…` },
      async () => {
        let leaseName: string;
        try {
          leaseName = await request.create();
        } catch (err) {
          onFailure(err instanceof Error ? err.message : String(err));
          return undefined;
        }
        services.pendingLeases.named(pending, leaseName);
        const outcome = await waitForLease(leaseName, {
          list: () => services.jmp.getLeases(client, false),
        });
        // The Leases view reads the listing before the request's row goes: the
        // lease's own row is then there to take its place, with no moment of neither.
        await leasesViewRead();
        switch (outcome) {
          case "acquired":
            void vscode.window.showInformationMessage(`Jumpstarter: lease '${leaseName}' acquired ${target}.`);
            break;
          case "ended":
            void vscode.window.showErrorMessage(
              `Jumpstarter: lease '${leaseName}' ${target} ended before it was held.`,
            );
            break;
          case "timeout":
            void vscode.window.showWarningMessage(
              `Jumpstarter: lease '${leaseName}' ${target} is still waiting after ${Math.round(LEASE_WAIT_MS / 60_000)} minutes. It stays in the Leases view.`,
            );
            break;
        }
        return outcome;
      },
    );
  } finally {
    services.pendingLeases.end(pending);
    // The views read again: the lease is held now (and its exporter with it), or its own row says where it is.
    services.notifyLeasesChanged();
  }
}
