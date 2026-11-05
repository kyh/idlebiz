import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { STAND_IN_KEY, startStandInModel } from "./stand-in-model";
import type { StandInModel } from "./stand-in-model";

// The stand-in the gate and e2e suites run real CLIs against, driven here by hand on its two
// wires, so what it answers is held on every machine, not only on a Mac with both CLIs.

let model: StandInModel;

beforeAll(async () => {
  model = await startStandInModel();
});

afterEach(() => {
  model.reset();
});

afterAll(async () => {
  await model.close();
});

/** The data of each event a streamed answer carries, in order. */
const eventsOf = (stream: string): JsonValue[] =>
  stream
    .split("\n\n")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const data = chunk.split("\n").find((line) => line.startsWith("data: "));
      return parseJson(data?.slice("data: ".length) ?? "null");
    });

/** Each of `events` that `schema` reads, as it reads it. */
const eventsLike = <T extends z.ZodType>(schema: T, events: readonly JsonValue[]): z.output<T>[] =>
  events.flatMap((event) => {
    const parsed = schema.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });

const ToolUse = z.object({
  content_block: z.object({ id: z.string(), name: z.string(), type: z.literal("tool_use") }),
  type: z.literal("content_block_start"),
});

const InputJson = z.object({
  delta: z.object({ partial_json: z.string(), type: z.literal("input_json_delta") }),
});

const TextDelta = z.object({
  delta: z.object({ text: z.string(), type: z.literal("text_delta") }),
});

const Started = z.object({
  message: z.object({ usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }) }),
  type: z.literal("message_start"),
});

const Ended = z.object({
  type: z.literal("message_delta"),
  usage: z.object({ output_tokens: z.number() }),
});

/** What a Messages answer does: one tool call, by id, name and input, or a last word. */
const claudeSaid = (stream: string) => {
  const events = eventsOf(stream);
  const [call] = eventsLike(ToolUse, events);
  const [input] = eventsLike(InputJson, events);
  const words = eventsLike(TextDelta, events).map(({ delta }) => delta.text);
  return call === undefined
    ? { said: words.join("") }
    : {
        id: call.content_block.id,
        input: input === undefined ? null : parseJson(input.delta.partial_json),
        name: call.content_block.name,
      };
};

const OutputItem = z.object({
  item: z.looseObject({ type: z.string() }),
  type: z.literal("response.output_item.done"),
});

/** The one item a Responses answer streams. */
const codexSaid = (stream: string) => eventsLike(OutputItem, eventsOf(stream)).at(0)?.item;

const post = async (path: string, body: JsonValue, headers: Record<string, string> = {}) => {
  const res = await fetch(`${model.url}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-api-key": STAND_IN_KEY, ...headers },
    method: "POST",
  });
  return { status: res.status, text: await res.text() };
};

const BASH_AND_READ = [
  { input_schema: {}, name: "Bash" },
  { input_schema: {}, name: "Read" },
];

/** A Messages request of claude's, with Bash and Read offered unless `tools` says otherwise. */
const messages = (history: JsonValue[], tools: JsonValue[] = BASH_AND_READ) =>
  post("/v1/messages?beta=true", { messages: history, model: "claude", tools });

/** What claude's model says to `history`, as `claudeSaid` reads it. */
const claudeTo = async (history: JsonValue[], tools?: JsonValue[]) => {
  const answered = await messages(history, tools);
  return claudeSaid(answered.text);
};

const prompt = (said: string): JsonValue => ({ content: said, role: "user" });

const called = (id: string, command: string): JsonValue => ({
  content: [{ id, input: { command }, name: "Bash", type: "tool_use" }],
  role: "assistant",
});

/** claude's next message after a call: its result, and a reminder after it, as claude adds one. */
const result = (id: string, output: string): JsonValue => ({
  content: [
    { content: [{ text: output, type: "text" }], tool_use_id: id, type: "tool_result" },
    { text: "<system-reminder>a reminder</system-reminder>", type: "text" },
  ],
  role: "user",
});

const TURN_TEXT = { verbosity: "low" };

/** A Responses request of codex's: it names no tools, and a title asks for a `format`. */
const responses = (input: JsonValue[], text: JsonValue = TURN_TEXT) =>
  post("/v1/responses", { input, text });

/** What codex's model says to `input`, as `codexSaid` reads it. */
const codexTo = async (input: JsonValue[]) => {
  const answered = await responses(input);
  return codexSaid(answered.text);
};

const codexPrompt = (said: string): JsonValue => ({
  content: [{ text: said, type: "input_text" }],
  role: "user",
  type: "message",
});

/** The id of the one call a Messages answer makes. */
const idOf = (said: ReturnType<typeof claudeSaid>): string => {
  if (!("id" in said)) {
    throw new Error(`no call in ${JSON.stringify(said)}`);
  }
  return said.id;
};

describe("the stand-in model on claude's Messages wire", () => {
  it("makes a script's calls in turn, each one past the call the request's last result answers", async () => {
    model.script("MARK-A", [
      { command: "echo one", kind: "shell" },
      { file: "/tmp/notes.txt", kind: "read" },
      { kind: "say", text: "all done" },
    ]);
    const first = await messages([prompt("MARK-A tidy the README")]);
    expect(first.status).toBe(200);
    const one = claudeSaid(first.text);
    expect(one).toMatchObject({ input: { command: "echo one" }, name: "Bash" });
    const history = [prompt("MARK-A tidy the README"), called(idOf(one), "echo one")];
    const second = await claudeTo([...history, result(idOf(one), "one")]);
    expect(second).toMatchObject({ input: { file_path: "/tmp/notes.txt" }, name: "Read" });
    // the earlier result is still in the history: the last one decides
    const third = await messages([
      ...history,
      result(idOf(one), "one"),
      called(idOf(second), "read"),
      result(idOf(second), "the notes"),
    ]);
    expect(claudeSaid(third.text)).toEqual({ said: "all done" });
    expect(model.toolOutputs("MARK-A")).toEqual(["one", "the notes"]);
    expect(
      model.requests.map(({ marker, protocol, step }) => ({ marker, protocol, step })),
    ).toEqual([0, 1, 2].map((step) => ({ marker: "MARK-A", protocol: "messages", step })));
  });

  it("says done past a script's last move, to a request with no marker, and to one offering no shell", async () => {
    model.script("MARK-B", [{ command: "true", kind: "shell" }]);
    const call = await claudeTo([prompt("MARK-B go")]);
    const past = await messages([
      prompt("MARK-B go"),
      called(idOf(call), "true"),
      result(idOf(call), ""),
    ]);
    expect(claudeSaid(past.text)).toEqual({ said: "done" });
    expect(await claudeTo([prompt("no marker here")])).toEqual({ said: "done" });
    const title = await messages([prompt("MARK-B go")], [{ input_schema: {}, name: "Grep" }]);
    expect(claudeSaid(title.text)).toEqual({ said: "done" });
    expect(model.requests.at(-1)).toMatchObject({ marker: null, step: null, tools: ["Grep"] });
  });

  it("reads the step from the last user message, past the system message claude sends after it", async () => {
    model.script("MARK-J", [
      { command: "echo one", kind: "shell" },
      { kind: "say", text: "after the result" },
    ]);
    const call = await claudeTo([prompt("MARK-J")]);
    const said = await claudeTo([
      prompt("MARK-J"),
      called(idOf(call), "echo one"),
      result(idOf(call), "one"),
      {
        content: [{ text: "<total_tokens>1000 tokens left</total_tokens>", type: "text" }],
        role: "system",
      },
    ]);
    expect(said).toEqual({ said: "after the result" });
  });

  it("starts a resumed session's script again, from the new prompt", async () => {
    model.script("MARK-C", [{ command: "echo again", kind: "shell" }]);
    const call = await claudeTo([prompt("MARK-C first")]);
    const resumed = await messages([
      prompt("MARK-C first"),
      called(idOf(call), "echo again"),
      result(idOf(call), "again"),
      { content: [{ text: "done", type: "text" }], role: "assistant" },
      prompt("MARK-C second"),
    ]);
    const again = claudeSaid(resumed.text);
    expect(again).toMatchObject({ input: { command: "echo again" }, name: "Bash" });
    // a call of its own, so its output is told apart from the first turn's
    expect(idOf(again)).not.toBe(idOf(call));
  });

  it("answers the new prompt's marker over an older one's in the history", async () => {
    model.script("MARK-OLD", [{ command: "echo old", kind: "shell" }]);
    model.script("MARK-NEW", [{ command: "echo new", kind: "shell" }]);
    const said = await messages([
      prompt("MARK-OLD first"),
      { content: [{ text: "done", type: "text" }], role: "assistant" },
      prompt("MARK-NEW second"),
    ]);
    expect(claudeSaid(said.text)).toMatchObject({ input: { command: "echo new" } });
  });

  it("counts any request's tokens as one", async () => {
    const counted = await post("/v1/messages/count_tokens?beta=true", { messages: [] });
    expect(counted).toEqual({ status: 200, text: JSON.stringify({ input_tokens: 1 }) });
    expect(model.requests).toMatchObject([{ protocol: "count_tokens" }]);
  });

  it("answers claude's hello, and names any other path it was asked", async () => {
    const hello = await fetch(`${model.url}/api/hello`, { headers: { "x-api-key": STAND_IN_KEY } });
    expect(hello.status).toBe(200);
    const { status } = await post("/v1/models", {});
    expect(status).toBe(404);
    expect(model.unexpected).toEqual(["POST /v1/models"]);
  });

  it("turns away any key but its own, and records where it came, never what it was", async () => {
    const refused = await post("/v1/messages", { messages: [] }, { "x-api-key": "sk-ant-real" });
    expect(refused.status).toBe(401);
    const bearer = await post("/v1/responses", { input: [] }, { authorization: "Bearer oauth" });
    expect(bearer.status).toBe(401);
    expect(model.leaks).toEqual([
      { header: "x-api-key", path: "/v1/messages" },
      { header: "authorization", path: "/v1/responses" },
    ]);
    expect(JSON.stringify(model.leaks)).not.toMatch(/sk-ant-real|oauth/u);
    expect(model.requests).toEqual([]);
    const signed = await post("/api/hello", {}, { authorization: `Bearer ${STAND_IN_KEY}` });
    expect(signed.status).toBe(200);
  });

  it("refuses a move claude has no tool for, and names it", async () => {
    model.script("MARK-D", [{ kind: "patch", patch: "*** Begin Patch" }]);
    const { status } = await messages([prompt("MARK-D")]);
    expect(status).toBe(400);
    expect(model.unexpected).toEqual([
      "POST /v1/messages?beta=true: MARK-D step 0 is a patch, which messages has no tool for",
    ]);
  });

  it("refuses a marker a call id could not carry", () => {
    expect(() => {
      model.script("two words", []);
    }).toThrow(/letters, digits and hyphens/u);
  });

  it("holds every answer to the step after a hold, a retry's too, until it is let go", async () => {
    model.script("MARK-E", [
      { command: "echo held", kind: "shell" },
      { kind: "hold" },
      { kind: "say", text: "let go" },
    ]);
    const call = await claudeTo([prompt("MARK-E")]);
    const answered = [
      prompt("MARK-E"),
      called(idOf(call), "echo held"),
      result(idOf(call), "held"),
    ];
    const parked = [messages(answered), messages(answered)];
    const late = await Promise.race([Promise.all(parked), sleep(200, "held")]);
    expect(late).toBe("held");
    expect(model.toolOutputs("MARK-E")).toEqual(["held"]);
    model.release();
    const answers = await Promise.all(parked);
    expect(answers.map(({ text: streamed }) => claudeSaid(streamed))).toEqual([
      { said: "let go" },
      { said: "let go" },
    ]);
  });

  it("reports a script's own tokens", async () => {
    model.script("MARK-F", [{ kind: "say", text: "costly" }], { input: 10_000, output: 1000 });
    const answered = await messages([prompt("MARK-F")]);
    const events = eventsOf(answered.text);
    expect(eventsLike(Started, events).map(({ message }) => message.usage)).toEqual([
      { input_tokens: 10_000, output_tokens: 1000 },
    ]);
    expect(eventsLike(Ended, events).map(({ usage }) => usage)).toEqual([{ output_tokens: 1000 }]);
  });
});

describe("the stand-in model on codex's Responses wire", () => {
  it("makes a script's command, then its patch, then its last word", async () => {
    model.script("MARK-G", [
      { command: "touch ran", kind: "shell" },
      { kind: "patch", patch: "*** Begin Patch\n*** End Patch" },
      { kind: "say", text: "patched" },
    ]);
    const first = await codexTo([codexPrompt("MARK-G work")]);
    expect(first).toMatchObject({
      arguments: JSON.stringify({ cmd: "touch ran" }),
      name: "exec_command",
      type: "function_call",
    });
    const CallId = z.object({ call_id: z.string() });
    const { call_id: ran } = CallId.parse(first);
    const history: JsonValue[] = [
      codexPrompt("MARK-G work"),
      { ...CallId.parse(first), arguments: "{}", name: "exec_command", type: "function_call" },
      { call_id: ran, output: "ran it", type: "function_call_output" },
    ];
    const second = await codexTo(history);
    expect(second).toMatchObject({
      input: "*** Begin Patch\n*** End Patch",
      name: "apply_patch",
      type: "custom_tool_call",
    });
    const { call_id: patched } = CallId.parse(second);
    const output = [{ text: "Success.", type: "input_text" }];
    const third = await responses([
      ...history,
      { call_id: patched, input: "", name: "apply_patch", type: "custom_tool_call" },
      { call_id: patched, output, type: "custom_tool_call_output" },
    ]);
    expect(codexSaid(third.text)).toMatchObject({
      content: [{ text: "patched", type: "output_text" }],
      type: "message",
    });
    expect(model.toolOutputs("MARK-G")).toEqual(["ran it", "Success."]);
    expect(model.requests.map(({ protocol, step }) => ({ protocol, step }))).toEqual(
      [0, 1, 2].map((step) => ({ protocol: "responses", step })),
    );
  });

  it("streams a last word as codex hands it on: its item announced, then its text", async () => {
    model.script("MARK-K", [{ kind: "say", text: "streamed" }]);
    const answered = await responses([codexPrompt("MARK-K")]);
    const Typed = z.looseObject({ type: z.string() });
    expect(eventsLike(Typed, eventsOf(answered.text)).map(({ type }) => type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    const Delta = z.object({ delta: z.string(), type: z.literal("response.output_text.delta") });
    expect(eventsLike(Delta, eventsOf(answered.text))).toMatchObject([{ delta: "streamed" }]);
  });

  it("says done to a request asking for a shape of answer, as codex's title does, though it carries a marker", async () => {
    model.script("MARK-L", [{ command: "touch ran", kind: "shell" }]);
    const title = await responses([codexPrompt("Title this: MARK-L work")], {
      format: { name: "codex_output_schema", type: "json_schema" },
    });
    expect(codexSaid(title.text)).toMatchObject({ content: [{ text: "done" }], type: "message" });
    expect(model.requests).toMatchObject([{ marker: null, step: null }]);
  });

  it("refuses a file read, which codex makes through its shell", async () => {
    model.script("MARK-H", [{ file: "/etc/hosts", kind: "read" }]);
    const { status } = await responses([codexPrompt("MARK-H")]);
    expect(status).toBe(400);
  });
});

describe("the stand-in model casting a team", () => {
  it("answers a request naming the company with its hires, and a scripted one with its script", async () => {
    const team = [
      { blurb: "Ships.", name: "Ada", persona: "A calm builder.", role: "engineer", title: "Eng" },
    ];
    model.hires("E2E Stand-in Co", team);
    const cast = await responses([codexPrompt("Company: E2E Stand-in Co\nInvent 5 hires.")]);
    expect(codexSaid(cast.text)).toMatchObject({
      content: [{ text: JSON.stringify(team), type: "output_text" }],
    });
    model.script("MARK-I", [{ kind: "say", text: "scripted" }]);
    const brief = await messages([prompt("MARK-I for E2E Stand-in Co")]);
    expect(claudeSaid(brief.text)).toEqual({ said: "scripted" });
  });
});
