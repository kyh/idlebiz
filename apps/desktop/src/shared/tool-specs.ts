import { z } from "zod";
import { LandingPathSchema } from "@/shared/bets";
import { INTEGRATION_KINDS } from "@/shared/domain";

// Every company tool, described once: the route the control plane serves, the
// body it parses, who may call it, and what the agent is told — docs and the
// example are rendered from here, so a renamed field cannot leave the prose
// teaching agents a request that now answers 400. Bodies are strict because a
// key an agent guessed (`bet_id` for `bet`) would otherwise be dropped and its
// optional field quietly defaulted.

const EMPTY = z.strictObject({});
const SLUG_AND_REASON = z.strictObject({
  reason: z.string().trim().min(1),
  slug: z.string().min(1),
});

/** What every bet names, whatever it counts. */
const WAGER = {
  budgetUsd: z.number().positive().max(1000),
  hypothesis: z.string().trim().min(1).max(600),
  product: z.string().min(1).optional(),
  target: z.number().positive(),
  title: z.string().trim().min(1).max(80),
  // long enough for a number to answer, short enough that a dud dies within the fortnight
  windowHours: z.number().min(1).max(336),
};

export interface ToolSpec<B extends z.ZodType> {
  method: "GET" | "POST";
  path: string;
  body: B;
  /** Headcount, the portfolio and the bets are the lead's alone; anyone else is told who to take it to. */
  leadOnly: string | null;
  doc: string;
  /** A request that parses, shown to the agent as the curl payload. */
  example: z.input<B>;
}

const tool = <B extends z.ZodType>(spec: ToolSpec<B>): ToolSpec<B> => spec;

// oxlint-disable-next-line sort-keys -- the order agents read them in: everyone's tools, then the lead's
export const TOOL_SPECS = {
  ask_boss: tool({
    body: z.strictObject({ question: z.string().trim().min(1) }),
    doc: "you are blocked or need a decision only the founder can make. Use sparingly; prefer making reasonable choices yourself. Note the answer arrives later — continue with whatever you can still do.",
    example: { question: "..." },
    leadOnly: null,
    method: "POST",
    path: "/v1/ask-boss",
  }),
  message_team: tool({
    body: z.strictObject({ text: z.string().trim().min(1) }),
    doc: "post a one-line update, decision, ask, or handoff to the team room so teammates see it live. The room already shows your name — never prefix messages with it.",
    example: { text: "..." },
    leadOnly: null,
    method: "POST",
    path: "/v1/message-team",
  }),
  read_team_chat: tool({
    body: EMPTY,
    doc: "catch up on the room before you act, so you build on teammates' work instead of duplicating it.",
    example: {},
    leadOnly: null,
    method: "GET",
    path: "/v1/team-chat",
  }),
  delegate: tool({
    body: z.strictObject({
      bet: z.string().min(1).optional(),
      description: z.string().min(1),
      product: z.string().min(1).optional(),
      role: z.string().min(1),
      title: z.string().min(1),
    }),
    doc: 'hand work to a teammate of a given role (they pick it up autonomously and report back in the room). Call once to chain a handoff, or several times to fan work out in parallel. It spends against your current bet and lands on its product; name another bet with `"bet":"<slug>"` to fund work elsewhere. `"product":"<slug>"` alone picks the product only when your run has no bet. It is refused when the bet has no room for another run: runs already in flight count against its budget before they bill.',
    example: { description: "...", role: "engineer", title: "..." },
    leadOnly: null,
    method: "POST",
    path: "/v1/delegate",
  }),
  read_bets: tool({
    body: EMPTY,
    doc: "the ledger: every live bet, what it has spent and brought in, and the latest verdicts.",
    example: {},
    leadOnly: null,
    method: "GET",
    path: "/v1/bets",
  }),
  request_integration: tool({
    body: z.strictObject({ kind: z.enum(INTEGRATION_KINDS), reason: z.string().trim().min(1) }),
    doc: 'the business needs a real-world connection: `"vercel"` (hosting, deploys, traffic analytics) or `"stripe"` (charging money). The founder gets a card with a Connect button; this task resumes automatically once they connect.',
    example: { kind: "vercel", reason: "..." },
    leadOnly: null,
    method: "POST",
    path: "/v1/request-integration",
  }),
  create_product: tool({
    body: z.strictObject({
      description: z.string().trim().min(1).max(600),
      name: z.string().trim().min(1).max(80),
    }),
    doc: "a genuinely separate product (its own code, its own deploy), not a feature of one you have. It gets its own workspace; open a bet on it to fund work there.",
    example: { description: "...", name: "..." },
    leadOnly: "Only the team lead can start a product — raise it in the team room.",
    method: "POST",
    path: "/v1/create-product",
  }),
  kill_product: tool({
    body: SLUG_AND_REASON,
    doc: "retire a product whose bets keep dying. Its package and workspace are archived whole, its live bets die with it, and the budget goes to the others. The last product cannot be killed: start its successor first.",
    example: { reason: "...", slug: "product-slug" },
    leadOnly: "Only the team lead can retire a product — make the case in the team room.",
    method: "POST",
    path: "/v1/kill-product",
  }),
  open_bet: tool({
    body: z.discriminatedUnion("metric", [
      z.strictObject({
        ...WAGER,
        landingPath: LandingPathSchema.optional(),
        metric: z.literal("users"),
      }),
      z.strictObject({ ...WAGER, metric: z.literal("revenue") }),
    ]),
    doc: 'the team only spends against bets, so this is how work gets funded. One falsifiable hypothesis about one product: `metric` is `"users"` or `"revenue"`, `target` is how much of it the bet must bring in, `budgetUsd` is the most the bet may burn, `windowHours` is how long the number gets to answer once the work stops. A bet counts only what carries its mark (see "Marking a bet\'s traffic"), so several can run on one product at once. A users bet gets a landing path of its own, `/b/<bet slug>`; pass `"landingPath":"/guides"` instead when the bet IS a set of pages (search pages, a docs section) — a path another live bet already covers is refused.',
    example: {
      budgetUsd: 3,
      hypothesis: "...",
      metric: "users",
      product: "product-slug",
      target: 50,
      title: "...",
      windowHours: 48,
    },
    leadOnly: "Only the team lead opens bets — pitch it in the team room.",
    method: "POST",
    path: "/v1/open-bet",
  }),
  measure_bet: tool({
    body: z.strictObject({ slug: z.string().min(1) }),
    doc: "the work that could move the number is out the door: stop spending on the bet and start its clock.",
    example: { slug: "bet-slug" },
    leadOnly: "Only the team lead starts a bet's clock — tell them the work is out the door.",
    method: "POST",
    path: "/v1/measure-bet",
  }),
  kill_bet: tool({
    body: SLUG_AND_REASON,
    doc: "give up on a bet before its window does. You cannot declare one won: only the real number can.",
    example: { reason: "...", slug: "bet-slug" },
    leadOnly: "Only the team lead can kill a bet — make the case in the team room.",
    method: "POST",
    path: "/v1/kill-bet",
  }),
  hire: tool({
    body: z.strictObject({
      name: z.string().min(1).optional(),
      persona: z.string().min(1).optional(),
      role: z.string().min(1),
      title: z.string().min(1),
    }),
    doc: "you lead the team and own headcount: add a role the backlog demands. Give a real first name and a vivid 2-3 sentence persona.",
    example: { name: "Mara", persona: "...", role: "engineer", title: "Frontend Engineer" },
    leadOnly: "Only the team lead can hire — raise it in the team room.",
    method: "POST",
    path: "/v1/hire",
  }),
  release: tool({
    body: z.strictObject({ reason: z.string().default(""), slug: z.string().min(1) }),
    doc: "let a teammate go when their role stopped pulling weight (their work is archived, never deleted).",
    example: { reason: "...", slug: "teammate-slug" },
    leadOnly: "Only the team lead can release teammates.",
    method: "POST",
    path: "/v1/release",
  }),
} as const;

export type ToolName = keyof typeof TOOL_SPECS;

export const TOOL_NAMES = Object.keys(TOOL_SPECS).filter(
  (name): name is ToolName => name in TOOL_SPECS,
);

const HEADERS = `-H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN"`;

const curlOf = (name: ToolName): string => {
  const { method, path, example } = TOOL_SPECS[name];
  const url = `"$IDLEBIZ_API_URL${path}"`;
  return method === "GET"
    ? `curl -s ${url} ${HEADERS}`
    : `curl -s -X POST ${url} ${HEADERS} -H "content-type: application/json" -d '${JSON.stringify(example)}'`;
};

/** The tool list as an employee's instructions carry it; the lead's tools only for the lead. */
export const toolDocs = (lead: boolean): string =>
  TOOL_NAMES.filter((name) => lead || TOOL_SPECS[name].leadOnly === null)
    .map((name) => `- **${name}** — ${TOOL_SPECS[name].doc}\n  \`${curlOf(name)}\``)
    .join("\n");
