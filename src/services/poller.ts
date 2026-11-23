/**
 * Poller — refreshes a view when there is a reason to, and polls only while something is happening.
 *
 * Each feature creates its own Poller around a `tick` callback. The poller:
 *  - fires `tick` on demand: when it starts, when its view is shown, when the
 *    window regains focus, and whenever `refreshNow()` is called (a refresh
 *    button, a changed config file, a lease the extension just changed);
 *  - polls for a while after `watch()`: right after a lease is acquired or
 *    released, when what the controller says is still changing;
 *  - polls all the time only if the user asks for it (`intervalSeconds()`
 *    above zero: the jumpstarter.pollIntervalSeconds setting), while started
 *    AND visible, four times slower while the window is unfocused;
 *  - pauses entirely while `setVisible(false)` (wire it to the tree view's
 *    onDidChangeVisibility);
 *  - never overlaps ticks — refreshes during a tick coalesce into one follow-up;
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
   * Seconds between background polls, read before every schedule so setting
   * changes apply immediately; zero is none. Defaults to the
   * jumpstarter.pollIntervalSeconds setting (0) when omitted.
   */
  intervalSeconds?: () => number;
  /** For log messages. */
  name?: string;
}

export function configuredPollIntervalSeconds(): number {
  const v = vscode.workspace
    .getConfiguration("jumpstarter")
    .get<number>("pollIntervalSeconds", 0);
  return v > 0 ? Math.max(5, v) : 0;
}

/** How often a watched view is read again, and for how long (see `Poller.watch`). */
export const WATCH_INTERVAL_SECONDS = 5;
export const WATCH_SECONDS = 120;

export class Poller implements vscode.Disposable {
  private readonly tick: () => Promise<void> | void;
  private readonly intervalSeconds: () => number;
  readonly name: string;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private visible = true;
  private focused: boolean;
  private inFlight: Promise<void> | undefined;
  private refreshRequested = false;
  private watchUntil = 0;
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
    this.refreshRequested = false;
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

  /**
   * Something just changed and is still settling (a lease was asked for, or
   * given back): refresh now, and keep reading every few seconds for a while.
   */
  watch(seconds = WATCH_SECONDS): Promise<void> {
    this.watchUntil = Math.max(this.watchUntil, Date.now() + seconds * 1000);
    return this.refreshNow();
  }

  /** Refresh and wait for queued updates too, rather than dropping a changed setting. */
  refreshNow(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) {
      this.refreshRequested = true;
      return this.inFlight;
    }
    // Defer the tick until inFlight is assigned, even if tick is synchronous.
    this.inFlight = Promise.resolve().then(async () => {
      try {
        do {
          this.refreshRequested = false;
          try {
            await this.tick();
          } catch (err) {
            this.tickErrorEmitter.fire(err);
          }
        } while (this.refreshRequested);
      } finally {
        this.inFlight = undefined;
        this.schedule();
      }
    });
    return this.inFlight;
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.started || !this.visible) {
      return;
    }
    let seconds: number;
    if (Date.now() < this.watchUntil) {
      seconds = WATCH_INTERVAL_SECONDS;
    } else {
      seconds = this.intervalSeconds();
      if (seconds <= 0) {
        return; // on demand only
      }
      seconds = Math.max(5, seconds);
      if (!this.focused) {
        // Back off while the window is unfocused.
        seconds *= 4;
      }
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
