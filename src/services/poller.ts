/**
 * Poller — interval polling with focus-refresh and pause-when-hidden.
 *
 * Each feature creates its own Poller around a `tick` callback. The poller:
 *  - fires `tick` every `intervalSeconds()` seconds while started AND visible
 *    AND the VS Code window is focused (unfocused windows keep a slow 4x
 *    interval so data does not go completely stale);
 *  - fires an immediate refresh when the window regains focus;
 *  - pauses entirely while `setVisible(false)` (wire it to the tree view's
 *    onDidChangeVisibility);
 *  - never overlaps ticks — a tick still in flight skips the next interval;
 *  - swallows tick rejections after reporting them via `onTickError`.
 *
 * The auth rule (never poll a client with an expired token) is enforced by
 * the tick implementations, typically via jmp.ensureAuthValid().
 */

import * as vscode from "vscode";

export interface PollerOptions {
  /** Called every poll and on refreshNow(); may be async. */
  tick: () => Promise<void> | void;
  /**
   * Current interval in seconds, read before every schedule so setting
   * changes apply immediately. Defaults to the jumpstarter.pollIntervalSeconds
   * setting (15s) when omitted.
   */
  intervalSeconds?: () => number;
  /** For log messages. */
  name?: string;
}

export function configuredPollIntervalSeconds(): number {
  const v = vscode.workspace
    .getConfiguration("jumpstarter")
    .get<number>("pollIntervalSeconds", 15);
  return Math.max(5, v);
}

export class Poller implements vscode.Disposable {
  private readonly tick: () => Promise<void> | void;
  private readonly intervalSeconds: () => number;
  readonly name: string;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private visible = true;
  private focused: boolean;
  private inFlight = false;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly tickErrorEmitter = new vscode.EventEmitter<unknown>();
  /** Fires with the rejection reason whenever a tick throws. */
  readonly onTickError: vscode.Event<unknown> = this.tickErrorEmitter.event;

  constructor(options: PollerOptions) {
    this.tick = options.tick;
    this.intervalSeconds = options.intervalSeconds ?? configuredPollIntervalSeconds;
    this.name = options.name ?? "poller";
    this.focused = vscode.window.state.focused;
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        const wasFocused = this.focused;
        this.focused = state.focused;
        if (!wasFocused && state.focused && this.started && this.visible) {
          // Focus regained: refresh immediately and restart the fast cadence.
          void this.refreshNow();
        }
      }),
    );
  }

  get running(): boolean {
    return this.started;
  }

  /** Begin polling (fires an immediate first tick when visible). */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.visible) {
      void this.refreshNow();
    }
  }

  /** Stop polling until start() is called again. */
  stop(): void {
    this.started = false;
    this.clearTimer();
  }

  /**
   * Pause/resume based on view visibility. Becoming visible triggers an
   * immediate refresh when started.
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (!visible) {
      this.clearTimer();
    } else if (this.started) {
      void this.refreshNow();
    }
  }

  /** Run a tick right now (also reschedules the next interval). */
  async refreshNow(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) {
      this.schedule();
      return;
    }
    this.inFlight = true;
    try {
      await this.tick();
    } catch (err) {
      this.tickErrorEmitter.fire(err);
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.started || !this.visible) {
      return;
    }
    let seconds = Math.max(5, this.intervalSeconds());
    if (!this.focused) {
      // Back off while the window is unfocused.
      seconds *= 4;
    }
    this.timer = setTimeout(() => void this.refreshNow(), seconds * 1000);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.tickErrorEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
