import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { defineCommand } from "citty";
import {
  EXIT_CODES_DOC,
  TOOL_NAMES,
  TOOL_OUTCOMES,
  TOOL_SPECS,
  ToolAnswerSchema,
  commandOf,
  encodeRequest,
  toolPath,
  verbOf,
} from "../server/tool-specs";
import type { ToolAnswer, ToolName, ToolOutcome } from "../server/tool-specs";

/** The verbs, each naming its tool. */
export const TOOL_VERBS: ReadonlyMap<string, ToolName> = new Map(
  TOOL_NAMES.map((name) => [verbOf(name), name]),
);

const summaryOf = (doc: string) => doc.split(/(?<=\.)\s/u, 1)[0] ?? doc;

const STDIN = "-";

const HOW_TO_SEND = `The request is one JSON argument, single-quoted, or ${STDIN} to read it from stdin, which keeps an apostrophe or many lines intact: idlebiz <tool> ${STDIN} <<'EOF' … EOF`;

/** A tool's whole doc, as `idlebiz <tool> --help` prints it. */
export const toolHelp = (name: ToolName) => {
  const { doc, leadOnly } = TOOL_SPECS[name];
  const lead = leadOnly === null ? "" : "\n\nOnly the team lead's runs may call it.";

  return `idlebiz ${verbOf(name)}: ${doc}${lead}\n\n  ${commandOf(name)}\n\n${HOW_TO_SEND}\n\nIt prints the answer and exits ${EXIT_CODES_DOC}.\n`;
};

interface ControlPlane {
  socket: string;
  token: string;
}

const controlPlaneOf = (env: NodeJS.ProcessEnv) => {
  const { IDLEBIZ_API_SOCKET: socket = "", IDLEBIZ_RUN_TOKEN: token = "" } = env;

  if (socket === "" || token === "") {
    throw new Error(
      "company tools answer only inside an employee's run, whose env names IDLEBIZ_API_SOCKET and IDLEBIZ_RUN_TOKEN",
    );
  }

  if (!path.isAbsolute(socket)) {
    throw new Error("IDLEBIZ_API_SOCKET must be the socket the run was handed");
  }

  return { socket, token } satisfies ControlPlane;
};

/** Where a call reads what it is handed: the run's env, and stdin for `-`. */
interface CallIo {
  env: NodeJS.ProcessEnv;
  stdin: () => Promise<string>;
}

const PROCESS_IO: CallIo = { env: process.env, stdin: () => text(process.stdin) };

const requestOf = async (verb: string, argument: string | undefined, io: CallIo) => {
  if (argument === undefined) {
    return "{}";
  }

  const typed = argument === STDIN ? await io.stdin() : argument;
  let parsed: JsonValue;

  try {
    parsed = parseJson(typed);
  } catch (error) {
    const why = error instanceof SyntaxError ? ` (${error.message})` : "";
    throw new Error(`${verb}'s request is not JSON${why}. ${HOW_TO_SEND}`, { cause: error });
  }

  return encodeRequest(parsed);
};

interface Reply {
  status: number;
  body: string;
}

const send = async (socket: string, name: ToolName, token: string, body: string) => {
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        agent: false,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
        path: toolPath(name),
        socketPath: socket,
      },
      resolve,
    );

    req.on("error", reject);
    req.end(body);
  });

  return { body: await text(res), status: res.statusCode ?? 0 } satisfies Reply;
};

const answerOf = ({ body, status }: Reply) => {
  let parsed: ToolAnswer;

  try {
    parsed = ToolAnswerSchema.parse(parseJson(body));
  } catch (error) {
    throw new Error(`the company answered ${status} in a shape this idlebiz does not read`, {
      cause: error,
    });
  }

  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  return { kind: parsed.kind, text: parsed.text } satisfies ToolOutcome;
};

/** Calls `name` with `argument`, answering how the call ended and the server's prose. */
export const callTool = async (
  name: ToolName,
  argument: string | undefined,
  io: CallIo = PROCESS_IO,
) => {
  const { socket, token } = controlPlaneOf(io.env);
  const body = await requestOf(verbOf(name), argument, io);
  let reply: Reply;

  try {
    reply = await send(socket, name, token, body);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the company did not answer on ${socket} (${why}): IdleBiz may have quit, or this run has ended`,
      { cause: error },
    );
  }

  return answerOf(reply);
};

/**
 * Runs `name`'s verb on the words typed after it: the server's prose on stdout, answering the exit
 * code its outcome leaves. Not a citty `run`, whose answer citty drops.
 */
export const runTool = async (name: ToolName, words: readonly string[]) => {
  const verb = verbOf(name);
  const flag = words.find((word) => word.startsWith("-") && word !== STDIN);

  if (flag !== undefined) {
    throw new Error(`${verb} takes its request as one JSON argument, not ${flag}`);
  }

  if (words.length > 1) {
    throw new Error(`${verb} takes one request: quote the JSON as a single argument`);
  }

  const outcome = await callTool(name, words[0]);
  process.stdout.write(`${outcome.text}\n`);

  return TOOL_OUTCOMES[outcome.kind].exit;
};

/** Every tool's verb, for the program's command list; `runTool` runs them. */
export const toolCommands = () =>
  Object.fromEntries(
    TOOL_NAMES.map((name) => [
      verbOf(name),
      defineCommand({ meta: { description: summaryOf(TOOL_SPECS[name].doc), name: verbOf(name) } }),
    ]),
  );
