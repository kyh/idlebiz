import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "@repo/domain/errors";
import type { JsonValue } from "@repo/domain/json";
import { ControlPlane } from "../server/control-plane";
import { runCli } from "../program";
import { callTool } from "./tools";

// short, so a socket's path under it fits macOS's limit wherever TMPDIR is
const box = mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ib-tools-"));
const controlPlane = new ControlPlane(path.join(box, "save"), path.join(box, "home"));

beforeAll(() => controlPlane.start());
afterAll(() => {
  controlPlane.stop();
  rmSync(box, { force: true, recursive: true });
});

const noStdin = (): Promise<string> => Promise.reject(new Error("nothing on stdin"));

/** A run the control plane answers with `answer`, and what it was called with. */
const aRun = async (answer: (route: string, raw: JsonValue) => Promise<string | null>) => {
  const calls: { route: string; raw: JsonValue }[] = [];
  const handle = await controlPlane.registerRun(async (route, raw) => {
    calls.push({ raw, route });
    return await answer(route, raw);
  });
  return { calls, env: handle.env, release: handle.release };
};

describe("a company tool's verb", () => {
  it("sends its request to the tool's route and answers the server's prose", async () => {
    const run = await aRun(() => Promise.resolve("Posted to the room."));
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
    const run = await aRun(() => Promise.resolve("Asked."));
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
    const run = await aRun(() => Promise.resolve("Nobody has posted yet."));
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
    const run = await aRun(() => Promise.resolve("never"));
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
    const run = await aRun(() =>
      Promise.reject(new BadRequestError('Send either {"question":"..."}')),
    );
    try {
      await expect(
        callTool("ask_boss", '{"action":"x"}', { env: run.env, stdin: noStdin }),
      ).rejects.toThrow('Send either {"question":"..."}');
    } finally {
      run.release();
    }
  });

  it("says the company did not answer once the run has settled, which closes its socket", async () => {
    const run = await aRun(() => Promise.resolve("never"));
    run.release();
    await expect(
      callTool("read_bets", undefined, { env: run.env, stdin: noStdin }),
    ).rejects.toThrow("the company did not answer");
  });

  it("answers only inside a run", async () => {
    await expect(callTool("read_bets", undefined, { env: {}, stdin: noStdin })).rejects.toThrow(
      "company tools answer only inside an employee's run",
    );
  });

  it.each(["run.sock", "./run.sock", "$IDLEBIZ_API_SOCKET"])(
    "calls on no socket but one the run was handed, whose path is absolute: %s",
    async (socket) => {
      const env = { IDLEBIZ_API_SOCKET: socket, IDLEBIZ_RUN_TOKEN: "token" };
      await expect(callTool("read_bets", undefined, { env, stdin: noStdin })).rejects.toThrow(
        "IDLEBIZ_API_SOCKET must be the socket the run was handed",
      );
    },
  );

  it("calls as no other run: a teammate's token on this run's socket is refused", async () => {
    const lead = await aRun(() => Promise.resolve("never"));
    const teammate = await aRun(() => Promise.resolve("never"));
    try {
      const env = {
        IDLEBIZ_API_SOCKET: teammate.env.IDLEBIZ_API_SOCKET,
        IDLEBIZ_RUN_TOKEN: lead.env.IDLEBIZ_RUN_TOKEN,
      };
      await expect(callTool("read_bets", undefined, { env, stdin: noStdin })).rejects.toThrow(
        "unknown or expired run token",
      );
      expect([...lead.calls, ...teammate.calls]).toEqual([]);
    } finally {
      lead.release();
      teammate.release();
    }
  });

  it("says the company did not answer once the server is gone", async () => {
    const run = await aRun(() => Promise.resolve("never"));
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
