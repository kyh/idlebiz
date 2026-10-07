// Each company tool as a verb an employee types in its shell: `idlebiz <tool> '<json>'`. A client of
// the control plane its run was handed (IDLEBIZ_API_URL, IDLEBIZ_RUN_TOKEN) and of nothing else: it
// sends the request as it is, and the server parses it against the tool's spec, so a refusal reads
// the same whoever asks. The answer is the server's prose on stdout; a call that never reached it,
// or that it could not take, exits 1 with why on stderr.

import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { text } from "node:stream/consumers";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { defineCommand } from "citty";
import { z } from "zod";
import { TOOL_NAMES, TOOL_SPECS, commandOf, verbOf } from "../server/tool-specs";
import type { ToolName } from "../server/tool-specs";

/** The verbs, each naming its tool. */
export const TOOL_VERBS: ReadonlyMap<string, ToolName> = new Map(
  TOOL_NAMES.map((name) => [verbOf(name), name]),
);

/** The doc's first sentence, for the command list. */
const summaryOf = (doc: string): string => doc.split(/(?<=\.)\s/u, 1)[0] ?? doc;

const STDIN = "-";

const HOW_TO_SEND = `The request is one JSON argument, single-quoted, or ${STDIN} to read it from stdin, which keeps an apostrophe or many lines intact: idlebiz <tool> ${STDIN} <<'EOF' … EOF`;

/** A tool's whole doc, as `idlebiz <tool> --help` prints it. */
export const toolHelp = (name: ToolName): string => {
  const { doc, leadOnly } = TOOL_SPECS[name];
  const lead = leadOnly === null ? "" : "\n\nOnly the team lead's runs may call it.";
  return `idlebiz ${verbOf(name)}: ${doc}${lead}\n\n  ${commandOf(name)}\n\n${HOW_TO_SEND}\n`;
};

// what the control plane serves (control-plane.ts)
const Answer = z.discriminatedUnion("ok", [
  z.object({ message: z.string(), ok: z.literal(true) }),
  z.object({ error: z.string(), ok: z.literal(false) }),
]);

// The control plane listens on loopback alone, so a call bound anywhere else was rerouted: a run
// setting the address must not carry its request, or its token, off this Mac.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface ControlPlane {
  url: string;
  token: string;
}

/** The control plane `env` names, refused unless it is this machine's. */
const controlPlaneOf = (env: NodeJS.ProcessEnv): ControlPlane => {
  const { IDLEBIZ_API_URL: url = "", IDLEBIZ_RUN_TOKEN: token = "" } = env;
  if (url === "" || token === "") {
    throw new Error(
      "company tools answer only inside an employee's run, whose env names IDLEBIZ_API_URL and IDLEBIZ_RUN_TOKEN",
    );
  }
  const parsed = URL.parse(url);
  if (
    parsed === null ||
    parsed.protocol !== "http:" ||
    !LOOPBACK.has(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("IDLEBIZ_API_URL must be the loopback address the run was handed");
  }
  return { token, url: parsed.origin };
};

/** Where a call reads what it is handed: the run's env, and stdin for `-`. */
interface CallIo {
  env: NodeJS.ProcessEnv;
  stdin: () => Promise<string>;
}

const PROCESS_IO: CallIo = { env: process.env, stdin: () => text(process.stdin) };

const NO_REQUEST = z.strictObject({});

interface Request {
  body: string;
  /** Whether it asks nothing: `{}`, as a tool that reads takes. */
  empty: boolean;
}

/** The request a call sends: its argument, stdin for `-`, or none; refused unless it is JSON. */
const requestOf = async (
  verb: string,
  argument: string | undefined,
  io: CallIo,
): Promise<Request> => {
  if (argument === undefined) {
    return { body: "{}", empty: true };
  }
  const body = argument === STDIN ? await io.stdin() : argument;
  let value: JsonValue;
  try {
    value = parseJson(body);
  } catch (error) {
    const why = error instanceof SyntaxError ? ` (${error.message})` : "";
    throw new Error(`${verb}'s request is not JSON${why}. ${HOW_TO_SEND}`, { cause: error });
  }
  return { body, empty: NO_REQUEST.safeParse(value).success };
};

interface Reply {
  status: number;
  body: string;
}

/**
 * One call to the control plane, waited on however long the tool takes: a deploy answers once
 * Vercel is done. Its own agent, never the global one, which a proxy in the env could reroute.
 */
const send = async (
  url: string,
  method: "GET" | "POST",
  token: string,
  body: string,
): Promise<Reply> => {
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      url,
      {
        agent: false,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method,
      },
      resolve,
    );
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
  return { body: await text(res), status: res.statusCode ?? 0 };
};

/** What a call answered: the server's prose, or its refusal as an error. */
const answerOf = ({ body, status }: Reply): string => {
  let parsed: z.infer<typeof Answer>;
  try {
    parsed = Answer.parse(parseJson(body));
  } catch (error) {
    throw new Error(`the company answered ${status} in a shape this idlebiz does not read`, {
      cause: error,
    });
  }
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.message;
};

/** Calls `name` with `argument`, answering the server's prose. */
export const callTool = async (
  name: ToolName,
  argument: string | undefined,
  io: CallIo = PROCESS_IO,
): Promise<string> => {
  const { method, path } = TOOL_SPECS[name];
  const verb = verbOf(name);
  const { token, url } = controlPlaneOf(io.env);
  const { body, empty } = await requestOf(verb, argument, io);
  if (method === "GET" && !empty) {
    throw new Error(`${verb} takes no request`);
  }
  let reply: Reply;
  try {
    reply = await send(`${url}${path}`, method, token, body);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`the company did not answer at ${url} (${why}): IdleBiz may have quit`, {
      cause: error,
    });
  }
  return answerOf(reply);
};

// no return type: CommandDef<T> is contravariant in T through `run`, so a leaf with args is not a
// bare CommandDef (citty's own SubCommandsDef takes any)
const toolCommand = (name: ToolName) =>
  defineCommand({
    args: {
      request: {
        description: `the request, as JSON, or ${STDIN} to read it from stdin`,
        required: false,
        type: "positional",
      },
    },
    meta: { description: summaryOf(TOOL_SPECS[name].doc), name: verbOf(name) },
    run: async ({ args, rawArgs }) => {
      const verb = verbOf(name);
      const flag = rawArgs.find((word) => word.startsWith("-") && word !== STDIN);
      if (flag !== undefined) {
        throw new Error(`${verb} takes its request as one JSON argument, not ${flag}`);
      }
      if (args._.length > 1) {
        throw new Error(`${verb} takes one request: quote the JSON as a single argument`);
      }
      const [argument] = args._;
      process.stdout.write(`${await callTool(name, argument)}\n`);
    },
  });

/** Every tool's verb, for the program's command list. */
export const toolCommands = () =>
  Object.fromEntries(TOOL_NAMES.map((name) => [verbOf(name), toolCommand(name)]));
