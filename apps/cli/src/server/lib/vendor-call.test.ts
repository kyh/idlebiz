import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError } from "./http";
import { answering } from "./vendor-call";

const says = (error: HttpError): string => `the vendor answered ${error.status}`;

const answeredWith = (status: number) => () =>
  Promise.reject(new HttpError(status, "https://api.vendor.test/v1/thing", new Headers()));

const unreached = () => Promise.reject(new TypeError("fetch failed"));

const drifted = () => z.object({ id: z.string() }).parse({ identifier: "thing_1" });

describe("a vendor's call", () => {
  it("answers what the vendor sent", async () => {
    expect(await answering("Vendor", "thing", () => Promise.resolve(7), says)).toEqual({
      kind: "ok",
      value: 7,
    });
  });

  it.each([
    { answer: { kind: "refused", reason: "the vendor answered 401", status: 401 }, status: 401 },
    { answer: { kind: "refused", reason: "the vendor answered 403", status: 403 }, status: 403 },
    { answer: { kind: "missing", reason: "the vendor answered 404" }, status: 404 },
    { answer: { kind: "rejected", reason: "the vendor answered 422" }, status: 422 },
    { answer: { kind: "down", reason: "the vendor answered 429" }, status: 429 },
    { answer: { kind: "down", reason: "the vendor answered 503" }, status: 503 },
  ])("sorts a $status in the vendor's words, and reports nothing", async ({ answer, status }) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await answering("Vendor", "thing", answeredWith(status), says)).toEqual(answer);
    expect(logged).not.toHaveBeenCalled();
  });

  it("answers a call that reached nobody as down", async () => {
    expect(await answering("Vendor", "thing", unreached, says)).toEqual({
      kind: "down",
      reason: "fetch failed",
    });
  });

  it("reports an answer its schema refuses once, under the call, and answers it as down", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await answering("Vendor", "thing", drifted, says)).toEqual({
      kind: "down",
      reason:
        "Vendor answered in a shape IdleBiz does not read, which a change on Vendor's side causes; try again later",
    });
    expect(logged).toHaveBeenCalledExactlyOnceWith("[Vendor thing]", expect.any(z.ZodError));
  });
});
