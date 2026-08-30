/**
 * Opening a Jumpstarter YAML config for editing.
 *
 * When the file belongs to another user (a system-wide exporter config under
 * /etc/jumpstarter, say), tell the user how to edit it with privileges rather
 * than letting them discover it after typing and failing to save.
 */

import * as vscode from "vscode";
import { promises as fs } from "fs";

import { Services } from "../services";
import { isWritable, sudoEditCommand } from "./openConfig/access";

export { isWritable, sudoEditCommand } from "./openConfig/access";

/**
 * Open a config file in the editor.
 *
 * The document opens either way; when it is not writable the user is offered
 * the privileged alternatives instead of hitting a failed save later.
 */
export async function openConfigForEditing(
  services: Services,
  filePath: string,
  label: string,
): Promise<void> {
  try {
    await fs.stat(filePath);
  } catch {
    void vscode.window.showErrorMessage(`Jumpstarter: ${label} not found at ${filePath}`);
    return;
  }

  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document, { preview: false });

  if (await isWritable(filePath)) {
    return;
  }

  const command = sudoEditCommand(filePath);
  services.jmp.log(`${label} is not writable by this user: ${filePath}`);
  const choice = await vscode.window.showWarningMessage(
    `${label} is owned by another user, so edits cannot be saved from here.`,
    "Open Terminal",
    "Copy sudoedit Command",
  );
  if (choice === "Open Terminal") {
    const terminal = vscode.window.createTerminal({ name: "Jumpstarter config" });
    terminal.show();
    // Left unsent: running a privileged editor is the user's call.
    terminal.sendText(command, false);
  } else if (choice === "Copy sudoedit Command") {
    await vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage(`Copied: ${command}`);
  }
}
