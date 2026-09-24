import { z } from "zod";
import {
  LandingPathSchema,
  MAX_LIVE_BETS_PER_PRODUCT,
  MAX_LIVE_PRODUCTS,
  MIN_BET_TARGET,
} from "@/shared/bets";
import { INTEGRATION_KINDS, KillReasonSchema, ProductDraftSchema } from "@/shared/domain";
import { formatUsd } from "@/shared/format";

// Every company tool, described once: the route the control plane serves, the
// body it parses, who may call it, and what the agent is told — docs and the
// example are rendered from here, so a renamed field cannot leave the prose
// teaching agents a request that now answers 400. Bodies are strict because a
// key an agent guessed (`bet_id` for `bet`) would otherwise be dropped and its
// optional field quietly defaulted.

const EMPTY = z.strictObject({});
const SLUG_AND_REASON = z.strictObject({ reason: KillReasonSchema, slug: z.string().min(1) });

/** What every bet names, whatever it counts. */
const WAGER = {
  budgetUsd: z.number().positive().max(1000),
  hypothesis: z.string().trim().min(1).max(600),
  product: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(80),
  // long enough for a number to answer, short enough that a dud dies within the fortnight
  windowHours: z.number().min(1).max(336),
};

/**
 * How long a deploy may take. The agent's call waits on it without a word, so it
 * stays well inside the run's idle watchdog (`DEFAULT_IDLE_TIMEOUT_MS`).
 */
export const DEPLOY_TIMEOUT_MS = 5 * 60_000;

const USERS_FLOOR = `a users target is a whole number of visitors, at least ${MIN_BET_TARGET.users}: fewer is won by the founder's own clicks`;
const REVENUE_FLOOR = `a revenue target is at least ${formatUsd(MIN_BET_TARGET.revenue)}: less is won by a single charge`;

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
      title: z.string().trim().min(1).max(80),
    }),
    doc: 'hand work to a teammate of a given role (they pick it up autonomously and report back in the room). Call once to chain a handoff, or several times to fan work out in parallel. It spends against your current bet and lands on its product; name another bet with `"bet":"<slug>"` to fund work elsewhere. `"product":"<slug>"` alone picks the product only when your run has no bet. From a run that is opening a bet, name the bet it opened. It is refused when the bet has no room for another run: runs already in flight count against its budget before they bill.',
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
    doc: 'the business needs a real-world connection: `"vercel"` (hosting, deploys, traffic analytics) or `"stripe"` (counting revenue; read-only, cannot create payments). The founder gets a card with a Connect button; this task resumes automatically once they connect.',
    example: { kind: "vercel", reason: "..." },
    leadOnly: null,
    method: "POST",
    path: "/v1/request-integration",
  }),
  deploy: tool({
    body: z.strictObject({ product: z.string().min(1).optional() }),
    doc: `publish the product's folder to production on Vercel and get its live URL back. It deploys your run's product; name another with \`"product":"<slug>"\`. The founder signs off on each deploy: the first call is held, and calling again once they answer runs it, so build and check it passes in that same run, right before the call. Keep Vercel's config in \`vercel.json\`: a folder holding \`vercel.ts\` (or .mts, .js, .mjs, .cjs) is not deployed. It answers once Vercel is done, which can take up to ${DEPLOY_TIMEOUT_MS / 60_000} minutes: let the call run that long.`,
    example: {},
    leadOnly: null,
    method: "POST",
    path: "/v1/deploy",
  }),
  create_payment_link: tool({
    body: z.strictObject({
      amountUsd: z.number().min(0.5).max(10_000),
      bet: z.string().min(1).optional(),
      // JSON quoting leaves format characters raw: a direction override would let the
      // name visually rewrite the price the founder signs
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(
          /^[^\p{Cc}\p{Cf}]+$/u,
          "name must be plain text: no control, zero-width or direction-changing characters",
        ),
      product: z.string().min(1).optional(),
    }),
    doc: 'the only way to charge: creates a Stripe payment link that charges `amountUsd` once, in USD, for what `name` says, and answers with its URL. Every payment through it is tagged for your run\'s product (name another with `"product":"<slug>"`) and, with `"bet":"<slug>"`, for that open revenue bet on the product, so the app counts it for both. The founder signs off on each link: the first call is held, and calling again once they answer creates it.',
    example: { amountUsd: 9, bet: "bet-slug", name: "..." },
    leadOnly: null,
    method: "POST",
    path: "/v1/payment-link",
  }),
  create_product: tool({
    body: ProductDraftSchema,
    doc: `a genuinely separate product (its own code, its own deploy), not a feature of one you have. It gets its own workspace; open a bet on it to fund work there. The company runs at most ${MAX_LIVE_PRODUCTS} at once: past that, a new one replaces one you kill_product.`,
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
        target: z.number().int(USERS_FLOOR).min(MIN_BET_TARGET.users, USERS_FLOOR),
      }),
      z.strictObject({
        ...WAGER,
        metric: z.literal("revenue"),
        target: z.number().min(MIN_BET_TARGET.revenue, REVENUE_FLOOR),
      }),
    ]),
    doc: `the team only spends against bets, so this is how work gets funded. One falsifiable hypothesis about one product: \`metric\` is \`"users"\` or \`"revenue"\`, \`target\` is how much of it the bet must bring in (at least ${MIN_BET_TARGET.users} users, a whole number, or ${formatUsd(MIN_BET_TARGET.revenue)}), \`budgetUsd\` is the most the bet may burn, \`windowHours\` is how long the number gets to answer once the work stops. A bet counts only what carries its mark (see "Marking a bet's traffic"), so several can run on one product at once, up to ${MAX_LIVE_BETS_PER_PRODUCT} live. A users bet gets a landing path of its own, \`/b/<bet slug>\`; pass \`"landingPath":"/guides"\` instead when the bet IS a set of pages it creates (search pages, a docs section). Name only a new section, since a path that already gets visitors counts them too: the whole site, \`/b\` and any path another bet holds are refused.`,
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
    doc: "the work that could move the number is out the door: stop spending on the bet and start its clock. Refused while nothing can read that number: no Stripe key for a revenue bet, no Vercel project on a users bet's product.",
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
      name: z.string().trim().min(1).max(40).optional(),
      persona: z.string().trim().min(1).max(600).optional(),
      role: z.string().min(1),
      title: z.string().trim().min(1).max(60),
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
