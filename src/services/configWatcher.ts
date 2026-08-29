/**
 * ConfigWatcher — watches the Jumpstarter client config directory
 * ($JMP_CLIENT_CONFIG_HOME or ~/.config/jumpstarter) so logins, client
 * creations/deletions and `jmp config client use` switches made in external
 * terminals are picked up by the extension.
 *
 * Fires a single debounced onDidChangeConfig event for any create/change/
 * delete under the directory (config.yaml holds config.current-client;
 * clients/<alias>.yaml holds each client).
 */

import * as vscode from "vscode";
import * as os from "os";
import { resolveConfigHome } from "./jmpProtocol";

const DEBOUNCE_MS = 300;

export class ConfigWatcher implements vscode.Disposable {
  /** Absolute path of the watched config directory. */
  readonly configHome: string;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Debounced: something under the config home changed. */
  readonly onDidChangeConfig: vscode.Event<void> = this.changeEmitter.event;

  private readonly watcher: vscode.FileSystemWatcher;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(configHome?: string) {
    this.configHome = configHome ?? resolveConfigHome(process.env, os.homedir());
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.configHome), "**/*"),
    );
    const fire = () => this.fireDebounced();
    this.watcher.onDidCreate(fire);
    this.watcher.onDidChange(fire);
    this.watcher.onDidDelete(fire);
  }

  private fireDebounced(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.changeEmitter.fire();
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.watcher.dispose();
    this.changeEmitter.dispose();
  }
}
