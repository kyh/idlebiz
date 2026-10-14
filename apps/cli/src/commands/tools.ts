// Each company tool as a verb an employee types in its shell: `idlebiz <tool> '<json>'`. A client of
// the control plane its run was handed (IDLEBIZ_API_SOCKET, IDLEBIZ_RUN_TOKEN) and of nothing else:
// it sends the request in its shortest JSON (`encodeRequest`), the weight the spec's limits count,
// and the server parses it against the tool's spec, so a refusal reads the same whoever asks. The
// answer is the server's prose on stdout, however the call ended, and the exit code says how
// (TOOL_OUTCOMES). A call that never reached the server, or that it could not take, exits 1 with
// why on stderr.

import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { defineCommand } from "citty";
import type { CommandDef } from "citty";
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

/** The doc's first sentence, for the command list. */
const summaryOf = (doc: string): string => doc.split(/(?<=\.)\s/u, 1)[0] ?? doc;

const STDIN = "-";

const HOW_TO_SEND = `The request is one JSON argument, single-quoted, or ${STDIN} to read it from stdin, which keeps an apostrophe or many lines intact: idlebiz <tool> ${STDIN} <<'EOF' … EOF`;

/** A tool's whole doc, as `idlebiz <tool> --help` prints it. */
export const toolHelp = (name: ToolName): string => {
  const { doc, leadOnly } = TOOL_SPECS[name];
  const lead = leadOnly === null ? "" : "\n\nOnly the team lead's runs may call it.";
  return `idlebiz ${verbOf(name)}: ${doc}${lead}\n\n  ${commandOf(name)}\n\n${HOW_TO_SEND}\n\nIt prints the answer and exits ${EXIT_CODES_DOC}.\n`;
};

interface ControlPlane {
  socket: string;
  token: string;
}

/**
 * The control plane `env` names: the run's own unix socket, which main hands it as an absolute
 * path, so a relative one was set by the run, and resolving it against the run's folders would
 * reach whatever listens there.
 */
const controlPlaneOf = (env: NodeJS.ProcessEnv): ControlPlane => {
  const { IDLEBIZ_API_SOCKET: socket = "", IDLEBIZ_RUN_TOKEN: token = "" } = env;
  if (socket === "" || token === "") {
    throw new Error(
      "company tools answer only inside an employee's run, whose env names IDLEBIZ_API_SOCKET and IDLEBIZ_RUN_TOKEN",
    );
  }
  if (!path.isAbsolute(socket)) {
    throw new Error("IDLEBIZ_API_SOCKET must be the socket the run was handed");
  }
  return { socket, token };
};

/** Where a call reads what it is handed: the run's env, and stdin for `-`. */
interface CallIo {
  env: NodeJS.ProcessEnv;
  stdin: () => Promise<string>;
}

const PROCESS_IO: CallIo = { env: process.env, stdin: () => text(process.stdin) };

/** The request a call sends: its argument, stdin for `-`, or none; refused unless it is JSON. */
const requestOf = async (
  verb: string,
  argument: string | undefined,
  io: CallIo,
): Promise<string> => {
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

/**
 * One call to the control plane over the run's socket, waited on however long the tool takes: a
 * deploy answers once Vercel is done. Its own agent, never the global one, which a proxy in the
 * env could reroute.
 */
const send = async (
  socket: string,
  name: ToolName,
  token: string,
  body: string,
): Promise<Reply> => {
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
  return { body: await text(res), status: res.statusCode ?? 0 };
};

/** What a call answered: how it ended and the server's prose, or the call's refusal as an error. */
const answerOf = ({ body, status }: Reply): ToolOutcome => {
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
  return { kind: parsed.kind, text: parsed.text };
};

/** Calls `name` with `argument`, answering how the call ended and the server's prose. */
export const callTool = async (
  name: ToolName,
  argument: string | undefined,
  io: CallIo = PROCESS_IO,
): Promise<ToolOutcome> => {
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
export const runTool = async (name: ToolName, words: readonly string[]): Promise<number> => {
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
export const toolCommands = (): Record<string, CommandDef> =>
  Object.fromEntries(
    TOOL_NAMES.map((name) => [
      verbOf(name),
      defineCommand({ meta: { description: summaryOf(TOOL_SPECS[name].doc), name: verbOf(name) } }),
    ]),
  );
