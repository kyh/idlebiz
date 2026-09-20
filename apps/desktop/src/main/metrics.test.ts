import { describe, expect, it } from "vitest";
import { sumCharges } from "./metrics";

const charge = (id: string, amount: number, product?: string) => {
  const metadata: Record<string, string> = product === undefined ? {} : { product };
  return { amount, amount_refunded: 0, id, metadata, paid: true };
};

describe("sumCharges", () => {
  it("follows the list past its first hundred", async () => {
    const asked: (string | null)[] = [];
    const revenue = await sumCharges((after) => {
      asked.push(after);
      return Promise.resolve(
        after === null
          ? { data: [charge("ch_1", 1000), charge("ch_2", 500)], has_more: true }
          : { data: [charge("ch_3", 250)], has_more: false },
      );
    });
    expect(revenue?.total).toBe(17.5);
    expect(asked).toEqual([null, "ch_2"]);
  });

  it("credits a product with what its tag claims, in the same read", async () => {
    const revenue = await sumCharges(() =>
      Promise.resolve({
        data: [charge("ch_1", 1000, "app"), charge("ch_2", 500, "app"), charge("ch_3", 250)],
      }),
    );
    expect(revenue?.total).toBe(17.5);
    expect([...(revenue?.byProduct ?? [])]).toEqual([["app", 15]]);
  });

  it("counts what was kept: not unpaid charges, not refunds", async () => {
    const revenue = await sumCharges(() =>
      Promise.resolve({
        data: [
          { ...charge("ch_1", 1000), amount_refunded: 1000 },
          { ...charge("ch_2", 1000), amount_refunded: 300 },
          { ...charge("ch_3", 900), paid: false },
        ],
      }),
    );
    expect(revenue?.total).toBe(7);
  });

  it("reports nothing rather than half a total", async () => {
    const revenue = await sumCharges((after) =>
      Promise.resolve(
        after === null ? { data: [charge("ch_1", 1000)], has_more: true } : "rate limited",
      ),
    );
    expect(revenue).toBeNull();
  });
});
