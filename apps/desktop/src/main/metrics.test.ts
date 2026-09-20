import { describe, expect, it } from "vitest";
import { afterLastId, byPageToken, sumCharges } from "./metrics";

const charge = (id: string, amount: number, extra: Record<string, number | boolean> = {}) => ({
  amount,
  id,
  paid: true,
  ...extra,
});

describe("sumCharges", () => {
  it("follows the list API past its first hundred", async () => {
    const asked: (string | null)[] = [];
    const total = await sumCharges((cursor) => {
      asked.push(cursor);
      return Promise.resolve(
        cursor === null
          ? { data: [charge("ch_1", 1000), charge("ch_2", 500)], has_more: true }
          : { data: [charge("ch_3", 250)], has_more: false },
      );
    }, afterLastId);
    expect(total).toBe(17.5);
    expect(asked).toEqual([null, "ch_2"]);
  });

  it("follows the search API by its page token", async () => {
    const total = await sumCharges(
      (cursor) =>
        Promise.resolve(
          cursor === null
            ? { data: [charge("ch_1", 1000)], has_more: true, next_page: "tok" }
            : { data: [charge("ch_2", 1000)], has_more: false, next_page: null },
        ),
      byPageToken,
    );
    expect(total).toBe(20);
  });

  it("counts what was kept: not unpaid charges, not refunds", async () => {
    const total = await sumCharges(
      () =>
        Promise.resolve({
          data: [
            charge("ch_1", 1000, { amount_refunded: 1000 }),
            charge("ch_2", 1000, { amount_refunded: 300 }),
            charge("ch_3", 900, { paid: false }),
          ],
        }),
      afterLastId,
    );
    expect(total).toBe(7);
  });

  it("reports nothing rather than half a total", async () => {
    const total = await sumCharges(
      (cursor) =>
        Promise.resolve(
          cursor === null ? { data: [charge("ch_1", 1000)], has_more: true } : "rate limited",
        ),
      afterLastId,
    );
    expect(total).toBeNull();
  });
});
