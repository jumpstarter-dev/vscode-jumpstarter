/**
 * Resolving an IconSpec to something a TreeItem can show.
 *
 * Almost every icon in the extension is a codicon, which follows the user's
 * theme and takes a ThemeColor. A couple of states have no codicon at all —
 * there is no outline circle-x, for one — and those ship as SVGs in
 * media/icons, named by the `asset` field of the spec.
 *
 * initIconAssets() is called once from activate(); until it is, specs fall
 * back to their codicon, so nothing breaks in a test that skips it.
 */

import * as vscode from "vscode";
import { IconSpec } from "./exporters/model";

let assetRoot: vscode.Uri | undefined;

export function initIconAssets(extensionUri: vscode.Uri): void {
  assetRoot = vscode.Uri.joinPath(extensionUri, "media", "icons");
}

/** The icon for a spec: the bundled SVG when it has one, else the codicon. */
export function resolveIcon(spec: IconSpec): vscode.ThemeIcon | vscode.Uri {
  if (spec.asset && assetRoot) {
    return vscode.Uri.joinPath(assetRoot, `${spec.asset}.svg`);
  }
  return new vscode.ThemeIcon(
    spec.id,
    spec.colorId ? new vscode.ThemeColor(spec.colorId) : undefined,
  );
}
