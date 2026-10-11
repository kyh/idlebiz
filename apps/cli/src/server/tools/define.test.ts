import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "@repo/domain/errors";
import type { RunContext } from "./define";

const {
  BET,
  BOUND_ACTION,
  DEPLOYED,
  HANDOFF,
  VERCEL,
  callTool,
  connectVercel,
  deployingRun,
  runAs,
} = await import("./fixtures");
const store = await import("../store/store");
const { callTool: outcomeOf } = await import("./index");
const { ControlPlane } = await import("../control-plane");
const { runCli } = await import("../../program");

describe("company tools", () => {
  it("turns the lead's tools away from anyone else, before looking at the body", async () => {
    const { ctx } = runAs("priya");
    expect(await outcomeOf(ctx, "open_bet", {})).toEqual({
      kind: "refused",
      text: "Only the team lead opens bets — pitch it in the team room.",
    });
    expect(store.listBets()).toEqual([]);
  });

  it("answers what a tool did as done", async () => {
    const { ctx } = runAs("priya");
    expect(await outcomeOf(ctx, "message_team", { text: "on it" })).toEqual({
      kind: "done",
      text: "Posted to the team room.",
    });
  });

  it("answers with the store's refusal, as refused, rather than failing the call", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    expect(await outcomeOf(ctx, "kill_bet", { reason: "dud", slug: "no-such-bet" })).toEqual({
      kind: "refused",
      text: 'no live bet "no-such-bet"',
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it("answers what a tool turns down by its own check as refused", async () => {
    const { ctx } = runAs("mae");
    expect(await outcomeOf(ctx, "release", { slug: "mae" })).toEqual({
      kind: "refused",
      text: "You can't release yourself.",
    });
  });

  it("answers a fault too, so the run goes on, and reports it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    const fault = new TypeError("cannot read the queue");
    const broken: RunContext = {
      ...ctx,
      assign: () => {
        throw fault;
      },
    };
    expect(await outcomeOf(broken, "delegate", HANDOFF)).toEqual({
      kind: "fault",
      text: fault.message,
    });
    expect(logged).toHaveBeenCalledExactlyOnceWith("[tool delegate]", fault);
  });

  it("calls a body that does not parse the caller's error", async () => {
    const { ctx } = runAs("mae");
    await expect(callTool(ctx, "open_bet", { ...BET, target: -1 })).rejects.toThrow(
      BadRequestError,
    );
    await expect(callTool(ctx, "open_bet", { ...BET, target: 1 })).rejects.toThrow("at least 10");
    expect(store.listBets()).toEqual([]);
  });

  it("keeps the first thing a run asks the founder, refusing the next", async () => {
    const { ctx, asked } = runAs("priya");
    expect(await outcomeOf(ctx, "ask_boss", { question: "Ship it?" })).toMatchObject({
      kind: "done",
    });
    const unsent = await outcomeOf(ctx, "request_integration", {
      kind: "vercel",
      reason: "to deploy",
    });
    expect(unsent?.kind).toBe("refused");
    expect(unsent?.text).toContain("The founder was not asked");
    expect(asked).toEqual([{ question: "Ship it?", type: "question" }]);
    expect(ctx.asks.current()).toEqual({ question: "Ship it?", type: "question" });
  });
});

describe("an idlebiz verb, through the control plane to the tools", () => {
  // short, so a socket's path under it fits macOS's limit wherever TMPDIR is
  const box = mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ib-verb-"));
  const plane = new ControlPlane(path.join(box, "save"), path.join(box, "home"));

  beforeAll(() => plane.start());
  afterAll(() => {
    plane.stop();
    rmSync(box, { force: true, recursive: true });
  });

  /** `argv` typed in `ctx`'s run: the exit code it left, and what it wrote to stdout and stderr. */
  const typed = async (ctx: RunContext, argv: readonly string[]) => {
    const handle = await plane.registerRun((name, raw) => outcomeOf(ctx, name, raw));
    vi.stubEnv("IDLEBIZ_API_SOCKET", handle.env.IDLEBIZ_API_SOCKET);
    vi.stubEnv("IDLEBIZ_RUN_TOKEN", handle.env.IDLEBIZ_RUN_TOKEN);
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    try {
      const code = await runCli(argv);
      return { code, err: err.join(""), out: out.join("") };
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      vi.unstubAllEnvs();
      handle.release();
    }
  };

  it("exits 0 on a call done, printing what it did", async () => {
    const { ctx } = runAs("priya");
    expect(await typed(ctx, ["message-team", '{"text":"on it"}'])).toEqual({
      code: 0,
      err: "",
      out: "Posted to the team room.\n",
    });
  });

  it.each([
    [
      "the lead's tool, typed by anyone else",
      "priya",
      ["open-bet", JSON.stringify(BET)],
      "Only the team lead opens bets — pitch it in the team room.",
    ],
    [
      "the store's refusal",
      "mae",
      ["kill-bet", '{"reason":"dud","slug":"no-such-bet"}'],
      'no live bet "no-such-bet"',
    ],
  ])("exits 1 on %s, printing why", async (_, who, argv, why) => {
    const { ctx } = runAs(who);
    expect(await typed(ctx, argv)).toEqual({ code: 1, err: "", out: `${why}\n` });
  });

  it("exits 1 on a request its tool does not take, with the server's why on stderr", async () => {
    const { ctx } = runAs("priya");
    const answered = await typed(ctx, ["read-team-chat", '{"limit":5}']);
    expect(answered).toMatchObject({ code: 1, out: "" });
    expect(answered.err).toContain('Unrecognized key: "limit"');
  });

  it("exits 4 on a deploy held for the founder's sign-off, so a chain after it stops", async () => {
    connectVercel();
    const { ctx, deploys } = deployingRun(DEPLOYED);
    store.setProductVercel("acme", VERCEL);
    expect(await typed(ctx, ["deploy"])).toEqual({
      code: 4,
      err: "",
      out: `Held for the founder's sign-off on "${BOUND_ACTION}". End your turn: the task resumes on their answer, and calling the tool again then runs it.\n`,
    });
    expect(deploys).toEqual([]);
  });

  it("exits 2 on a fault, printing it, and reports it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    const fault = new TypeError("cannot read the queue");
    const broken: RunContext = {
      ...ctx,
      assign: () => {
        throw fault;
      },
    };
    expect(await typed(broken, ["delegate", JSON.stringify(HANDOFF)])).toEqual({
      code: 2,
      err: "",
      out: `${fault.message}\n`,
    });
    expect(logged).toHaveBeenCalledExactlyOnceWith("[tool delegate]", fault);
  });
});
