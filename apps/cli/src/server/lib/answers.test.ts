import { ORPCError } from "@orpc/server";
import { ValidationError } from "@orpc/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RefusalError } from "../refusal";
import { answerOf } from "./answers";

const seatCap = "the office is at its 12-seat cap";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the answer to a call that threw", () => {
  it("turns a refusal into the store's bare sentence, and reports nothing", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = answerOf(new RefusalError(seatCap), "employees.direct");
    expect(answer).toBeInstanceOf(ORPCError);
    expect(answer.code).toBe("CONFLICT");
    expect(answer.message).toBe(seatCap);
    expect(log).not.toHaveBeenCalled();
  });

  it("answers a fault with its message too, and reports it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fault = new Error("EACCES: permission denied");
    const answer = answerOf(fault, "save.openFolder");
    expect(answer.code).toBe("INTERNAL_SERVER_ERROR");
    expect(answer.message).toBe(fault.message);
    expect(log).toHaveBeenCalledExactlyOnceWith("[rpc]", fault);
  });

  it("passes an answer oRPC already worded as it is", () => {
    const missing = new ORPCError("NOT_FOUND", { message: "no such procedure" });
    expect(answerOf(missing, "nowhere")).toBe(missing);
  });
});

describe("an input its schema refuses", () => {
  const post = z.object({ text: z.string().min(1).max(2000) });
  const refusalOf = (text: string | number) => {
    const parsed = post["~standard"].validate({ text });
    if (parsed instanceof Promise || parsed.issues === undefined) {
      throw new Error("the schema took it");
    }
    const invalid = new ValidationError({
      invalidData: { text },
      issues: parsed.issues,
      message: "Input validation failed",
    });
    return answerOf(new ORPCError("BAD_REQUEST", { cause: invalid }), "team.post");
  };

  it("tells the founder the limit text went over, and reports nothing", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = refusalOf("x".repeat(2100));
    expect(answer.code).toBe("CONFLICT");
    expect(answer.message).toBe("Keep it to 2000 characters or fewer.");
    expect(log).not.toHaveBeenCalled();
  });

  it("answers any other misfit as a fault, and reports it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = refusalOf(7);
    expect(answer.code).toBe("BAD_REQUEST");
    expect(answer.message).toMatch(/^\[rpc:team\.post\] input validation failed/u);
    expect(log).toHaveBeenCalledOnce();
  });
});
