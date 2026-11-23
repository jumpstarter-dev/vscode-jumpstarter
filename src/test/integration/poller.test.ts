import * as assert from "assert";
import { Poller } from "../../services/poller";

suite("poller refresh coordination", () => {
  test("concurrent refreshes wait for one non-overlapping follow-up tick", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let setting = false;
    const observed: boolean[] = [];
    let active = 0;
    const poller = new Poller({
      tick: async () => {
        assert.equal(++active, 1, "ticks must never overlap");
        observed.push(setting);
        if (observed.length === 1) {
          started();
          await blocked;
        }
        active--;
      },
    });
    try {
      const first = poller.refreshNow();
      await firstStarted;
      setting = true;
      const second = poller.refreshNow();
      const third = poller.refreshNow();
      release();
      await Promise.all([first, second, third]);
      assert.deepEqual(observed, [false, true]);
    } finally {
      release();
      poller.dispose();
    }
  });

  test("nothing is read in the background, except for a while after watch()", async () => {
    let ticks = 0;
    const poller = new Poller({ tick: () => void ticks++, intervalSeconds: () => 0 });
    const scheduled = () => (poller as unknown as { timer?: unknown }).timer !== undefined;
    try {
      poller.start();
      await poller.refreshNow();
      assert.ok(ticks >= 1);
      assert.equal(scheduled(), false, "on demand: no poll is waiting");

      await poller.watch();
      assert.equal(scheduled(), true, "watching: the next poll is waiting");

      await poller.watch(0);
      (poller as unknown as { watchUntil: number }).watchUntil = 0;
      await poller.refreshNow();
      assert.equal(scheduled(), false, "the watch is over: on demand again");
    } finally {
      poller.dispose();
    }
  });

  test("stopping on an auth failure cancels an already queued refresh", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let ticks = 0;
    const poller = new Poller({ tick: async () => {
      ticks++;
      started();
      await blocked;
      throw new Error("expired token");
    } });
    const listener = poller.onTickError(() => poller.stop());
    try {
      const first = poller.refreshNow();
      await firstStarted;
      const queued = poller.refreshNow();
      release();
      await Promise.all([first, queued]);
      assert.equal(ticks, 1);
    } finally {
      release();
      listener.dispose();
      poller.dispose();
    }
  });
});
