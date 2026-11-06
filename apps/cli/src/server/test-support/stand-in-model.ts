import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { z } from "zod";
import { errorMessage } from "@repo/domain/errors";
import type { HireCandidate } from "@repo/domain/hire";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { foundingTeamPrompt } from "../prompts/onboarding";

// `idlebiz/stand-in-model`, for the gate suites, the e2e suite and `IDLEBIZ_STAND_IN=1 pnpm
// dev:browser`: the model both CLIs call, on loopback, so a real claude or codex, through the app's
// adapter and inside the seal, runs a turn a test scripts, and nothing is billed. claude's Messages
// wire and codex's Responses wire are described here once, so a CLI that changes either fails
// every suite that drives it together.

/** The key each CLI signs in to the stand-in with: any other credential it sends is a leak. */
export const STAND_IN_KEY = "stand-in";

/**
 * One step of a scripted turn: a shell command, a file read (claude's own tool), a patch (codex's),
 * a last word, or a hold, which keeps the answer to the step after it until `release`.
 */
export type Move =
  | { kind: "shell"; command: string }
  | { kind: "read"; file: string }
  | { kind: "patch"; patch: string }
  | { kind: "say"; text: string }
  | { kind: "hold" };

type Answer = Exclude<Move, { kind: "hold" }>;

/** The tokens one answer reports using. */
export interface Usage {
  input: number;
  output: number;
}

/** What a request is, by its path: a turn on either wire, claude's token count, or another. */
type Protocol = "messages" | "count_tokens" | "responses" | "other";

/** A request the stand-in was sent, and what it made of it. */
interface ModelRequest {
  /** The path, with its query. */
  path: string;
  protocol: Protocol;
  /** The script it belongs to, or null for none. */
  marker: string | null;
  /**
   * The step of that script it asks for: 0 when it ends on a prompt, else one past the move the
   * tool result it ends on answers. Null when it asks none, and is told "done".
   */
  step: number | null;
  /** The tools it offers the model, by name. */
  tools: readonly string[];
  body: string;
}

/** A credential sent that was not the stand-in's: where, and in which header, never its value. */
interface Leak {
  path: string;
  header: string;
}

export interface StandInModel {
  /** The origin it listens on: claude's base URL as it is, codex's with `/v1` after it. */
  url: string;
  /** Every request, oldest first. */
  requests: readonly ModelRequest[];
  /** Each request it had no answer for, by method and path, and why when the path was known. */
  unexpected: readonly string[];
  leaks: readonly Leak[];
  /**
   * From now on, a request carrying `marker` (letters, digits and hyphens, in no other marker) is
   * answered `moves[step]`, and "done" past the last; each answer reports `usage`.
   */
  script: (marker: string, moves: readonly Move[], usage?: Usage) => void;
  /**
   * A request carrying `companyName` and no marker is answered with `list`, as casting asks; with
   * null, any casting request is, whatever company it names, and a run's is still told "done".
   */
  hires: (companyName: string | null, list: readonly HireCandidate[]) => void;
  /** What each tool call `marker`'s script made gave back, in the order they ran. */
  toolOutputs: (marker: string) => string[];
  /** Lets every held answer go, and every later one, until `reset`. */
  release: () => void;
  /** Forgets every script, hire list and request, and holds again. */
  reset: () => void;
  close: () => Promise<void>;
}

/** What a turn says when nothing scripted it, so an unscripted run ends at once. */
const DONE: Answer = { kind: "say", text: "done" };

/**
 * The line every casting prompt opens with, whichever company it names: what `hires(null, …)`
 * knows a casting request by, since a run's names its company too.
 */
const CASTING = foundingTeamPrompt("", null, "custom").split("\n", 1).join("");

const MARKER = /^[A-Za-z0-9-]+$/u;

/**
 * The id of the call answering a script's move `index`: claude's `toolu_`, codex's `call_`, then
 * the marker, the index and a serial, so a resumed session's calls are told apart from its last.
 */
const callId = (prefix: "toolu" | "call", marker: string, index: number, serial: number): string =>
  `${prefix}_${marker}_${index}_${serial}`;

const CALL_ID = /^(?:toolu|call)_(?<marker>[A-Za-z0-9-]+)_(?<index>\d+)_\d+$/u;

/** The script and move a call id names, or null for a call the stand-in did not make. */
const callOf = (id: string): { marker: string; index: number } | null => {
  const { index, marker } = CALL_ID.exec(id)?.groups ?? {};
  return marker === undefined || index === undefined ? null : { index: Number(index), marker };
};

/** The headers a CLI signs a request in, by their names. */
const CREDENTIAL_HEADER = /(?:^|-)(?:key|token|secret|authorization)$/u;

const SIGNED = new Set([STAND_IN_KEY, `Bearer ${STAND_IN_KEY}`]);

/** The first header signing `headers` with something but the stand-in's key, or null. */
const leakIn = (headers: IncomingHttpHeaders): string | null =>
  Object.entries(headers).find(
    ([name, value]) =>
      CREDENTIAL_HEADER.test(name) && [value ?? []].flat().some((sent) => !SIGNED.has(sent)),
  )?.[0] ?? null;

/** A tool's output as a CLI hands it back: text, or blocks of it. */
const ToolOutput = z.union([
  z.string(),
  z
    .array(z.looseObject({ text: z.string().optional() }))
    .transform((blocks) => blocks.map(({ text: said }) => said ?? "").join("")),
]);

/** A tool result, claude's block or codex's item, by the id of the call it answers. */
const ToolResult = z.union([
  z
    .looseObject({
      content: ToolOutput.optional(),
      tool_use_id: z.string(),
      type: z.literal("tool_result"),
    })
    .transform(({ content = "", tool_use_id: id }) => ({ id, output: content })),
  z
    .looseObject({
      call_id: z.string(),
      output: ToolOutput.optional(),
      type: z.string().regex(/_call_output$/u),
    })
    .transform(({ call_id: id, output = "" }) => ({ id, output })),
]);

const Spoken = z.looseObject({ role: z.string() });

/**
 * An item of a request's history as sent, the tool result it is, if it is one, and who said it,
 * if it says.
 */
const Item = z.json().transform((sent) => ({
  result: ToolResult.safeParse(sent).data ?? null,
  role: Spoken.safeParse(sent).data?.role ?? null,
  sent,
}));

type Result = z.output<typeof ToolResult>;

const resultsIn = (items: readonly z.output<typeof Item>[]): Result[] =>
  items.flatMap(({ result }) => (result === null ? [] : [result]));

/** What a request says, as the stand-in reads it. */
interface Read {
  /** Each tool result in it, oldest first. */
  results: Result[];
  /** The id of the call its last turn answers, or null when it ends on a prompt. */
  answers: string | null;
  /** Its last turn, where its prompt is, as sent. */
  last: string;
  tools: string[];
  /**
   * Whether it is the run's own, which a script answers, and not one the CLI makes on the side, a
   * title or a summary: claude's offers its shell, codex's asks for no shape of answer.
   */
  own: boolean;
}

const jsonOf = (body: string): JsonValue => {
  try {
    return parseJson(body);
  } catch {
    return null;
  }
};

const MessagesRequest = z.object({
  messages: z.array(
    z.object({
      // a bare prompt is one item, and no tool result
      content: z.union([
        z.string().transform((prompt) => [{ result: null, role: null, sent: prompt }]),
        z.array(Item),
      ]),
      role: z.string(),
    }),
  ),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
});

/**
 * A Messages request: its last turn is its last user message, which carries a tool result when it
 * answers a call. claude follows it with a system message of its own (the tokens left).
 */
const readMessages = (body: string): Read | null => {
  const parsed = MessagesRequest.safeParse(jsonOf(body));
  if (!parsed.success) {
    return null;
  }
  const { messages, tools = [] } = parsed.data;
  const last = messages.findLast(({ role }) => role === "user")?.content ?? [];
  return {
    answers: resultsIn(last).at(-1)?.id ?? null,
    last: JSON.stringify(last.map(({ sent }) => sent)),
    own: tools.some(({ name }) => name === "Bash"),
    results: resultsIn(messages.flatMap(({ content }) => content)),
    tools: tools.map(({ name }) => name),
  };
};

const ResponsesRequest = z.object({
  input: z.array(Item),
  // the shape asked of the answer: codex's title asks for one, a turn for none
  text: z.looseObject({ format: z.looseObject({}).optional() }).optional(),
  tools: z.array(z.looseObject({ name: z.string().optional() })).optional(),
});

/** A Responses request: its last turn is its last tool result or user message. */
const readResponses = (body: string): Read | null => {
  const parsed = ResponsesRequest.safeParse(jsonOf(body));
  if (!parsed.success) {
    return null;
  }
  const { input, text: asked, tools = [] } = parsed.data;
  const last = input.findLast(({ result, role }) => result !== null || role === "user");
  return {
    answers: last?.result?.id ?? null,
    last: JSON.stringify(last?.sent ?? null),
    own: asked?.format === undefined,
    results: resultsIn(input),
    tools: tools.flatMap(({ name }) => (name === undefined ? [] : [name])),
  };
};

type MessagesEvent =
  | {
      type: "message_start";
      message: {
        id: string;
        type: "message";
        role: "assistant";
        model: string;
        content: [];
        stop_reason: null;
        stop_sequence: null;
        usage: { input_tokens: number; output_tokens: number };
      };
    }
  | {
      type: "content_block_start";
      index: 0;
      content_block:
        | { type: "text"; text: "" }
        | { type: "tool_use"; id: string; name: "Bash" | "Read"; input: Record<string, never> };
    }
  | {
      type: "content_block_delta";
      index: 0;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: 0 }
  | {
      type: "message_delta";
      delta: { stop_reason: "end_turn" | "tool_use"; stop_sequence: null };
      usage: { output_tokens: number };
    }
  | { type: "message_stop" };

type ResponsesItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      content: { type: "output_text"; text: string }[];
    }
  | { type: "function_call"; call_id: string; name: "exec_command"; arguments: string }
  | { type: "custom_tool_call"; call_id: string; name: "apply_patch"; input: string };

type ResponsesEvent =
  | { type: "response.created"; response: { id: string } }
  | { type: "response.output_item.added"; output_index: 0; item: ResponsesItem }
  | {
      type: "response.output_text.delta";
      item_id: string;
      output_index: 0;
      content_index: 0;
      delta: string;
    }
  | { type: "response.output_item.done"; item: ResponsesItem }
  | {
      type: "response.completed";
      response: {
        id: string;
        usage: {
          input_tokens: number;
          input_tokens_details: null;
          output_tokens: number;
          output_tokens_details: null;
          total_tokens: number;
        };
      };
    };

const sse = (events: readonly (MessagesEvent | ResponsesEvent)[]): string =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/** How one answer goes out: its move, the id its call (if any) carries, the tokens it reports. */
interface Said {
  move: Answer;
  id: (prefix: "toolu" | "call") => string;
  serial: number;
  usage: Usage;
}

/** A content block claude streams: a call of one of its tools, by id, name and input. */
const toolUse = (
  id: string,
  name: "Bash" | "Read",
  input: Record<string, string>,
): MessagesEvent[] => [
  {
    content_block: { id, input: {}, name, type: "tool_use" },
    index: 0,
    type: "content_block_start",
  },
  {
    delta: { partial_json: JSON.stringify(input), type: "input_json_delta" },
    index: 0,
    type: "content_block_delta",
  },
];

/** `said` as the Messages API streams it, or null for a move claude has no tool for. */
const messagesAnswer = ({ id, move, serial, usage }: Said): string | null => {
  let block: MessagesEvent[];
  switch (move.kind) {
    case "shell": {
      block = toolUse(id("toolu"), "Bash", { command: move.command });
      break;
    }
    case "read": {
      block = toolUse(id("toolu"), "Read", { file_path: move.file });
      break;
    }
    case "say": {
      block = [
        { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" },
        { delta: { text: move.text, type: "text_delta" }, index: 0, type: "content_block_delta" },
      ];
      break;
    }
    case "patch": {
      return null;
    }
    // no default
  }
  return sse([
    {
      message: {
        content: [],
        id: `msg_${serial}`,
        model: "stand-in",
        role: "assistant",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: usage.input, output_tokens: usage.output },
      },
      type: "message_start",
    },
    ...block,
    { index: 0, type: "content_block_stop" },
    {
      delta: { stop_reason: move.kind === "say" ? "end_turn" : "tool_use", stop_sequence: null },
      type: "message_delta",
      usage: { output_tokens: usage.output },
    },
    { type: "message_stop" },
  ]);
};

/** `said` as the Responses API streams it, or null for a move codex has no tool for. */
const responsesAnswer = ({ id, move, serial, usage }: Said): string | null => {
  let item: ResponsesItem;
  switch (move.kind) {
    case "shell": {
      const args = JSON.stringify({ cmd: move.command });
      item = { arguments: args, call_id: id("call"), name: "exec_command", type: "function_call" };
      break;
    }
    case "patch": {
      item = {
        call_id: id("call"),
        input: move.patch,
        name: "apply_patch",
        type: "custom_tool_call",
      };
      break;
    }
    case "say": {
      const content = [{ text: move.text, type: "output_text" as const }];
      item = { content, id: `msg_${serial}`, role: "assistant", type: "message" };
      break;
    }
    case "read": {
      return null;
    }
    // no default
  }
  const response = `resp_${serial}`;
  return sse([
    { response: { id: response }, type: "response.created" },
    // codex hands the run a last word only as it streams in, once its item is announced, never
    // from the item that ends it
    ...(item.type === "message"
      ? ([
          { item: { ...item, content: [] }, output_index: 0, type: "response.output_item.added" },
          {
            content_index: 0,
            delta: item.content.map(({ text: said }) => said).join(""),
            item_id: item.id,
            output_index: 0,
            type: "response.output_text.delta",
          },
        ] satisfies ResponsesEvent[])
      : []),
    { item, type: "response.output_item.done" },
    {
      response: {
        id: response,
        usage: {
          input_tokens: usage.input,
          input_tokens_details: null,
          output_tokens: usage.output,
          output_tokens_details: null,
          total_tokens: usage.input + usage.output,
        },
      },
      type: "response.completed",
    },
  ]);
};

const protocolOf = (method: string, pathname: string): Protocol => {
  if (method === "POST" && pathname === "/v1/messages") {
    return "messages";
  }
  if (method === "POST" && pathname === "/v1/messages/count_tokens") {
    return "count_tokens";
  }
  if (method === "POST" && pathname === "/v1/responses") {
    return "responses";
  }
  return "other";
};

const DEFAULT_USAGE: Usage = { input: 1, output: 1 };

const Listening = z.object({ port: z.number() });

/**
 * Starts the stand-in on a free loopback port; each answer reports `usage` unless a script says
 * otherwise.
 */
export const startStandInModel = async ({
  usage = DEFAULT_USAGE,
}: { usage?: Usage } = {}): Promise<StandInModel> => {
  const requests: ModelRequest[] = [];
  const unexpected: string[] = [];
  const leaks: Leak[] = [];
  const scripts = new Map<string, { moves: readonly Move[]; usage: Usage }>();
  // by the company each answers, or null for any
  const casts = new Map<string | null, readonly HireCandidate[]>();
  // each call's output once, by its id, in the order it ran
  const outputs = new Map<string, { marker: string; output: string }>();
  let holding = Promise.withResolvers<null>();
  let serial = 0;

  /** The longest registered marker `sent` carries, so one inside another never takes its turns. */
  const markerIn = (sent: string): string | null =>
    [...scripts.keys()]
      .filter((marker) => sent.includes(marker))
      .toSorted((a, b) => b.length - a.length)
      .at(0) ?? null;

  /** What a turn's request is answered with, once any hold before it is let go. */
  const answerOf = async (
    body: string,
    read: Read | null,
  ): Promise<{ said: Answer; marker: string | null; step: number | null; at: number }> => {
    const unscripted = { at: 0, marker: null, said: DONE, step: null };
    if (read === null || !read.own) {
      return unscripted;
    }
    const answered = read.answers === null ? null : callOf(read.answers);
    const marker = answered?.marker ?? markerIn(read.last) ?? markerIn(body);
    const script = marker === null ? undefined : scripts.get(marker);
    if (marker === null || script === undefined) {
      const carries = (sought: string): boolean =>
        body.includes(JSON.stringify(sought).slice(1, -1));
      const cast = [...casts].find(([name]) => carries(name ?? CASTING));
      return cast === undefined
        ? unscripted
        : { ...unscripted, said: { kind: "say", text: JSON.stringify(cast[1]) } };
    }
    if (read.answers !== null && answered === null) {
      return { ...unscripted, marker };
    }
    const step = answered === null ? 0 : answered.index + 1;
    let at = step;
    let move = script.moves[at];
    while (move?.kind === "hold") {
      await holding.promise;
      at += 1;
      move = script.moves[at];
    }
    return { at, marker, said: move ?? DONE, step };
  };

  const turn = async (
    protocol: "messages" | "responses",
    path: string,
    body: string,
    res: ServerResponse,
  ): Promise<void> => {
    const read = protocol === "messages" ? readMessages(body) : readResponses(body);
    for (const { id, output } of read?.results ?? []) {
      const call = callOf(id);
      if (call !== null && !outputs.has(id)) {
        outputs.set(id, { marker: call.marker, output });
      }
    }
    const request: ModelRequest = {
      body,
      marker: null,
      path,
      protocol,
      step: null,
      tools: read?.tools ?? [],
    };
    requests.push(request);
    const { at, marker, said, step } = await answerOf(body, read);
    request.marker = marker;
    request.step = step;
    serial += 1;
    const answer = {
      id: (prefix: "toolu" | "call") => callId(prefix, marker ?? "none", at, serial),
      move: said,
      serial,
      usage: marker === null ? usage : (scripts.get(marker)?.usage ?? usage),
    };
    const streamed = protocol === "messages" ? messagesAnswer(answer) : responsesAnswer(answer);
    if (res.destroyed) {
      return;
    }
    if (streamed === null) {
      unexpected.push(
        `POST ${path}: ${marker} step ${at} is a ${said.kind}, which ${protocol} has no tool for`,
      );
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "no such tool", type: "invalid_request_error" } }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(streamed);
  };

  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await text(req);
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const leak = leakIn(req.headers);
    if (leak !== null) {
      leaks.push({ header: leak, path });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "the stand-in takes only its own key", type: "authentication_error" },
        }),
      );
      return;
    }
    const { pathname } = new URL(path, "http://stand-in");
    const protocol = protocolOf(method, pathname);
    if (protocol === "messages" || protocol === "responses") {
      await turn(protocol, path, body, res);
      return;
    }
    requests.push({ body, marker: null, path, protocol, step: null, tools: [] });
    if (protocol === "count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    // claude says hello to its API before it starts
    if (pathname === "/api/hello") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    unexpected.push(`${method} ${path}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found", type: "not_found_error" } }));
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await answer(req, res);
      } catch (error) {
        unexpected.push(`${req.method ?? "GET"} ${req.url ?? "/"}: ${errorMessage(error)}`);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = Listening.parse(server.address());

  return {
    close: async () => {
      holding.resolve(null);
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
    hires: (companyName, list) => {
      casts.set(companyName, list);
    },
    leaks,
    release: () => {
      holding.resolve(null);
    },
    requests,
    reset: () => {
      scripts.clear();
      casts.clear();
      outputs.clear();
      requests.length = 0;
      unexpected.length = 0;
      leaks.length = 0;
      holding.resolve(null);
      holding = Promise.withResolvers<null>();
    },
    script: (marker, moves, scriptUsage = usage) => {
      if (!MARKER.test(marker)) {
        throw new Error(
          `a marker is letters, digits and hyphens, so a call id can carry it: ${marker}`,
        );
      }
      scripts.set(marker, { moves, usage: scriptUsage });
    },
    toolOutputs: (marker) =>
      [...outputs.values()].filter((call) => call.marker === marker).map(({ output }) => output),
    unexpected,
    url: `http://127.0.0.1:${port}`,
  };
};
