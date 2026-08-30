/**
 * Pure (VS Code-free) file-access checks behind the config edit buttons.
 *
 * Exporter configs may live under /etc/jumpstarter/exporters, which is
 * root-owned: the editor will open such a file happily and only fail on save,
 * so writability is checked up front.
 */

import { constants, promises as fs } from "fs";

/** True when the current user can write the file. */
export async function isWritable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The command a user would run to edit a root-owned config in a terminal. */
export function sudoEditCommand(filePath: string): string {
  return `sudoedit ${filePath}`;
}
