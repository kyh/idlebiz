import { describe, expect, it } from "vitest";
import { Coalesced, latestWins } from "./ordering";

describe("latestWins", () => {
  it("drops an answer older than the one a slice already took", () => {
    const order = latestWins();
    const early = order.ticket();
    const late = order.ticket();
    expect(order.accepts("bets", late)).toBe(true);
    expect(order.accepts("bets", early)).toBe(false);
    expect(order.accepts("products", early)).toBe(true);
  });

  it("keeps the newer of two overlapping loads when the older lands last", async () => {
    const order = latestWins<"productStatus">();
    const kept: string[] = [];
    const load = async (answer: Promise<string>): Promise<void> => {
      const ticket = order.ticket();
      const value = await answer;
      if (order.accepts("productStatus", ticket)) {
        kept.push(value);
      }
    };
    const older = Promise.withResolvers<string>();
    const newer = Promise.withResolvers<string>();
    const loads = [load(older.promise), load(newer.promise)];
    newer.resolve("ready");
    await loads[1];
    older.resolve("building");
    await Promise.all(loads);
    expect(kept).toEqual(["ready"]);
  });
});

describe("Coalesced", () => {
  it("turns a burst of calls into one run in flight and one after it", async () => {
    let runs = 0;
    const release: (() => void)[] = [];
    const gate = new Coalesced(
      () =>
        // oxlint-disable-next-line promise/avoid-new -- the test releases each run by hand
        new Promise<void>((resolve) => {
          runs += 1;
          release.push(resolve);
        }),
    );
    const burst = [gate.call(), gate.call(), gate.call()];
    expect(runs).toBe(1);
    release[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);
    release[1]?.();
    await Promise.all(burst);
    expect(runs).toBe(2);
  });

  it("runs again after a run rejects", async () => {
    let runs = 0;
    const gate = new Coalesced(() => {
      runs += 1;
      return runs === 1 ? Promise.reject(new Error("main went away")) : Promise.resolve();
    });
    await expect(gate.call()).rejects.toThrow("main went away");
    await gate.call();
    expect(runs).toBe(2);
  });
});
