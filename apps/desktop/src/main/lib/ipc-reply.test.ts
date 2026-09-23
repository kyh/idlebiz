import { afterEach, describe, expect, it, vi } from "vitest";
import { settle } from "./ipc-reply";

const seatCap = "the office is at its 12-seat cap";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IPC reply", () => {
  it("answers with the handler's value", async () => {
    await expect(settle((n: number) => n + 1, 1)).resolves.toEqual({ ok: true, value: 2 });
    await expect(settle((name: string) => Promise.resolve({ name }), "Ada")).resolves.toEqual({
      ok: true,
      value: { name: "Ada" },
    });
  });

  it("turns a refusal into the store's bare sentence", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuse = (): number => {
      throw new Error(seatCap);
    };

    await expect(settle(refuse, undefined)).resolves.toEqual({ message: seatCap, ok: false });
    expect(log).toHaveBeenCalledOnce();
  });

  it("settles a refusal from an async handler the same way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refuseLater = async (): Promise<number> => {
      await Promise.resolve();
      throw new Error(seatCap);
    };

    await expect(settle(refuseLater, undefined)).resolves.toEqual({ message: seatCap, ok: false });
  });
});
