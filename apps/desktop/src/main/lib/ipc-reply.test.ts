import { afterEach, describe, expect, it, vi } from "vitest";
import { isReply } from "@/shared/ipc-channels";
import { RefusalError } from "@/shared/refusal";
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

  it("turns a refusal into the store's bare sentence, and reports nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuse = (): number => {
      throw new RefusalError(seatCap);
    };

    await expect(settle(refuse, undefined)).resolves.toEqual({ message: seatCap, ok: false });
    expect(log).not.toHaveBeenCalled();
  });

  it("settles a refusal from an async handler the same way", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuseLater = async (): Promise<number> => {
      await Promise.resolve();
      throw new RefusalError(seatCap);
    };

    await expect(settle(refuseLater, undefined)).resolves.toEqual({ message: seatCap, ok: false });
    expect(log).not.toHaveBeenCalled();
  });

  it("answers a fault with its message too, and reports it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fault = new Error("EACCES: permission denied");
    const fail = (): number => {
      throw fault;
    };

    await expect(settle(fail, undefined)).resolves.toEqual({ message: fault.message, ok: false });
    expect(log).toHaveBeenCalledExactlyOnceWith("[ipc]", fault);
  });

  it("is always what the preload takes for a reply, and nothing else is", async () => {
    const refused = await settle((): number => {
      throw new RefusalError(seatCap);
    }, undefined);
    expect(isReply(refused)).toBe(true);
    expect(isReply(await settle((n: number) => n, 1))).toBe(true);
    expect(isReply(await settle(() => {}, undefined))).toBe(true);
    const strays = [undefined, null, "ok", { value: 1 }, { ok: "yes" }, { ok: false }];
    expect(strays.filter(isReply)).toEqual([]);
  });
});
