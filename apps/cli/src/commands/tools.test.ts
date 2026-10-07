import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "@repo/domain/errors";
import type { JsonValue } from "@repo/domain/json";
import { controlPlane } from "../server/control-plane";
import { runCli } from "../program";
import { callTool } from "./tools";

beforeAll(() => controlPlane.start());
afterAll(() => controlPlane.stop());

const noStdin = (): Promise<string> => Promise.reject(new Error("nothing on stdin"));

/** A run the control plane answers with `answer`, and what it was called with. */
const aRun = (answer: (route: string, raw: JsonValue) => Promise<string | null>) => {
  const calls: { route: string; raw: JsonValue }[] = [];
  const handle = controlPlane.registerRun(async (route, raw) => {
    calls.push({ raw, route });
    return await answer(route, raw);
  });
  return { calls, env: handle.env, release: handle.release };
};

describe("a company tool's verb", () => {
  it("sends its request to the tool's route and answers the server's prose", async () => {
    const run = aRun(() => Promise.resolve("Posted to the room."));
    try {
      const said = await callTool("message_team", '{"text":"shipped it"}', {
        env: run.env,
        stdin: noStdin,
      });
      expect(said).toBe("Posted to the room.");
      expect(run.calls).toEqual([{ raw: { text: "shipped it" }, route: "POST /v1/message-team" }]);
    } finally {
      run.release();
    }
  });

  it("reads `-` from stdin, where an apostrophe needs no quoting", async () => {
    const run = aRun(() => Promise.resolve("Asked."));
    try {
      await callTool("ask_boss", "-", {
        env: run.env,
        stdin: () => Promise.resolve(`{"question":"Can't we ship Friday?"}\n`),
      });
      expect(run.calls).toEqual([
        { raw: { question: "Can't we ship Friday?" }, route: "POST /v1/ask-boss" },
      ]);
    } finally {
      run.release();
    }
  });

  it("calls a tool that reads with no request, and refuses one", async () => {
    const run = aRun(() => Promise.resolve("Nobody has posted yet."));
    const io = { env: run.env, stdin: noStdin };
    try {
      await expect(callTool("read_team_chat", undefined, io)).resolves.toBe(
        "Nobody has posted yet.",
      );
      await expect(callTool("read_team_chat", "{}", io)).resolves.toBe("Nobody has posted yet.");
      await expect(callTool("read_team_chat", '{"limit":5}', io)).rejects.toThrow(
        "read-team-chat takes no request",
      );
      expect(run.calls.map(({ route }) => route)).toEqual([
        "GET /v1/team-chat",
        "GET /v1/team-chat",
      ]);
    } finally {
      run.release();
    }
  });

  it("refuses a request that is not JSON, saying how to send one", async () => {
    const run = aRun(() => Promise.resolve("never"));
    try {
      const refused = callTool("message_team", "{text: hi}", { env: run.env, stdin: noStdin });
      await expect(refused).rejects.toThrow("message-team's request is not JSON");
      await expect(refused).rejects.toThrow("single-quoted, or - to read it from stdin");
      expect(run.calls).toEqual([]);
    } finally {
      run.release();
    }
  });

  it("answers the server's refusal as an error", async () => {
    const run = aRun(() => Promise.reject(new BadRequestError('Send either {"question":"..."}')));
    try {
      await expect(
        callTool("ask_boss", '{"action":"x"}', { env: run.env, stdin: noStdin }),
      ).rejects.toThrow('Send either {"question":"..."}');
    } finally {
      run.release();
    }
  });

  it("says when the run's token has run out", async () => {
    const run = aRun(() => Promise.resolve("never"));
    run.release();
    await expect(
      callTool("read_bets", undefined, { env: run.env, stdin: noStdin }),
    ).rejects.toThrow("unknown or expired run token");
  });

  it("answers only inside a run", async () => {
    await expect(callTool("read_bets", undefined, { env: {}, stdin: noStdin })).rejects.toThrow(
      "company tools answer only inside an employee's run",
    );
  });

  it.each([
    "https://127.0.0.1:4000",
    "http://evil.example",
    "http://127.0.0.1:80@evil.example",
    "http://user:pw@127.0.0.1:4000",
  ])("sends nothing anywhere but this Mac's loopback: %s", async (url) => {
    const env = { IDLEBIZ_API_URL: url, IDLEBIZ_RUN_TOKEN: "token" };
    await expect(callTool("read_bets", undefined, { env, stdin: noStdin })).rejects.toThrow(
      "IDLEBIZ_API_URL must be the loopback address the run was handed",
    );
  });

  it("says the company did not answer once the server is gone", async () => {
    const run = aRun(() => Promise.resolve("never"));
    controlPlane.stop();
    try {
      await expect(
        callTool("read_bets", undefined, { env: run.env, stdin: noStdin }),
      ).rejects.toThrow("the company did not answer");
    } finally {
      await controlPlane.start();
    }
  });
});

/** What the command writes from here on, kept from the test's own output. */
const captured = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { err: () => err.join(""), out: () => out.join("") };
};

describe("the idlebiz command", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("lists every tool's verb beside serve", async () => {
    const io = captured();
    expect(await runCli(["--help"])).toBe(0);
    expect(io.out()).toContain("serve");
    expect(io.out()).toContain("ask-boss");
    expect(io.out()).toContain("create-payment-link");
    vi.restoreAllMocks();
  });

  it.each(["ask-boss", "ask_boss"])("prints %s's whole doc for --help", async (verb) => {
    const io = captured();
    expect(await runCli([verb, "--help"])).toBe(0);
    expect(io.out()).toContain("idlebiz ask-boss: hand the founder something only they can do");
    expect(io.out()).toContain(`idlebiz ask-boss '{"action":`);
    vi.restoreAllMocks();
  });

  it("names the lead's tools as the lead's", async () => {
    const io = captured();
    await runCli(["hire", "--help"]);
    expect(io.out()).toContain("Only the team lead's runs may call it.");
    vi.restoreAllMocks();
  });

  it.each([
    [
      ["message-team", "--text", "hi"],
      "message-team takes its request as one JSON argument, not --text",
    ],
    [["message-team", "{", "}"], "message-team takes one request"],
    [["no-such-tool"], "Unknown command"],
  ])("refuses %j, exiting 1 with why on stderr", async (argv, why) => {
    const io = captured();
    expect(await runCli(argv)).toBe(1);
    expect(io.err()).toContain(why);
    expect(io.out()).toBe("");
    vi.restoreAllMocks();
  });
});
