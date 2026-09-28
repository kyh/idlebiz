import { z } from "zod";
import {
  LandingPathSchema,
  MAX_LIVE_BETS_PER_PRODUCT,
  MAX_LIVE_PRODUCTS,
  MIN_BET_TARGET,
} from "@/shared/bets";
import { INTEGRATION_KINDS, KillReasonSchema, ProductDraftSchema } from "@/shared/domain";
import { EnvNameSchema } from "@/shared/env-name";
import { formatUsd } from "@/shared/format";
import { CATALOG_PAGE, PrintPlacementSchema } from "@/shared/listing";

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

// JSON quoting leaves format characters raw: a direction override would let a name or a
// delivery visually rewrite the price the founder signs
const signedText = (field: string, max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^[^\p{Cc}\p{Cf}]+$/u,
      `${field} must be plain text on one line: no control, zero-width or direction-changing characters`,
    );

const SALE_NAME = signedText("name", 80);

/** Printful prices each variant to three addresses, and allows 120 calls a minute. */
const MAX_PRINT_VARIANTS = 6;

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
    body: z.union(
      [
        z.strictObject({ question: z.string().trim().min(1) }),
        z.strictObject({
          action: z.string().trim().min(1).max(120),
          // models send null or "" for a field they leave empty; either is no draft
          draft: z
            .string()
            .trim()
            .max(10_000)
            .nullish()
            .transform((draft) => (draft === undefined || draft === "" ? null : draft)),
          instructions: z.string().trim().min(1).max(4000),
        }),
      ],
      {
        // matching neither, zod says only "Invalid input"; the agent needs the two shapes
        error: (issue) =>
          issue.code === "invalid_union"
            ? 'Send either {"question":"..."} or {"action":"...","instructions":"..."}, with an optional "draft".'
            : undefined,
      },
    ),
    doc: "hand the founder something only they can do, in one of two kinds. An **action** is a step only a human can take: post this draft somewhere, sign up for a service, buy a domain, verify an email. `action` names it in a line, `instructions` say exactly where to go, what to do and what to send back, and `draft` is the text to paste, if there is one. Actions are how the team gets anything done that needs a human: when the next step is one, propose it rather than stall. The founder answers Done, with whatever you asked them to send back (a URL, a value, a key of this product's own, never IdleBiz's Stripe, Vercel or Printful key, which the tools already use and IdleBiz refuses to pass on), or Can't, with why. A **question**, `{\"question\":\"...\"}`, is for a decision only the founder can make: use it sparingly and prefer making reasonable choices yourself. Either way the answer arrives in a later run, so continue with whatever you can still do. Only a run's first ask reaches the founder.",
    example: {
      action: "Post the launch thread on r/SideProject",
      draft: "...",
      instructions: "...",
    },
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
    doc: 'the business needs a real-world connection: `"vercel"` (hosting, deploys, traffic analytics), `"stripe"` (counting revenue; read-only, cannot create payments) or `"printful"` (printing and shipping what sell_print lists). The founder gets a card with a Connect button; this task resumes automatically once they connect, and for `"stripe"` only once Stripe is live: while the key IdleBiz reads it with is in test mode it keeps waiting.',
    example: { kind: "vercel", reason: "..." },
    leadOnly: null,
    method: "POST",
    path: "/v1/request-integration",
  }),
  deploy: tool({
    body: z.strictObject({}),
    doc: `publish the product's folder to production on Vercel and get its live URL back. It deploys your run's own product, the folder your run has to itself once the founder signs off: a run on no product deploys nothing, and another product's deploy goes to a teammate on it with delegate. The folder's files go up as they are, less what \`.vercelignore\` and Vercel's defaults leave out (node_modules, .git, .env.local), and Vercel builds them on its own machines, with the settings in \`vercel.json\`. A product with no Vercel project gets a new one named after it. The founder signs off on each deploy: the first call is held, and calling again once they answer runs it, so build and check it passes in that same run, right before the call. A key the product needs goes in with set_env, never in a file: a deploy refuses a folder holding a value set_env was given under a server-only name. No tool sets the project's domains: a product that needs one sends the founder an ask_boss action. It answers once Vercel is done, which can take up to ${DEPLOY_TIMEOUT_MS / 60_000} minutes: let the call run that long.`,
    example: {},
    leadOnly: null,
    method: "POST",
    path: "/v1/deploy",
  }),
  set_env: tool({
    body: z.strictObject({
      name: EnvNameSchema,
      product: z.string().min(1).optional(),
      // Vercel's limit for every variable of a deployment together
      value: z
        .string()
        .trim()
        .min(1)
        .max(64 * 1024),
    }),
    doc: "keep a secret the product needs at runtime (an API key, a signing secret) as an environment variable of its Vercel project, for production and preview, with no sign-off. It sets it on your run's product; name another with `\"product\":\"<slug>\"`. The product needs a project first, which its first deploy makes. `name` is an uppercase variable name: Vercel's own (`VERCEL_*`, `NODE_ENV`) are refused. A name with a prefix a framework builds into the page (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `EXPO_PUBLIC_`…) is for what every visitor may read, such as a Stripe publishable key (`pk_`), kept out of the source; a value shaped like a secret (`sk_`, `rk_`, `whsec_`, a private key, another provider's API key), or one set_env keeps under a server-only name, is refused under one. Setting a name again replaces the value set_env gave it; a variable already on the project that set_env never set is the founder's, and is left as it is. It takes effect on the next deploy: server code reads it as `process.env.NAME`, and a page reads a public name the way its framework does (`process.env.NEXT_PUBLIC_X` in Next.js, `import.meta.env.VITE_X` in Vite); under a framework that does not read its prefix it stays server-only. Never write a server-only value into a file: deploy refuses a folder that holds one.",
    example: { name: "OPENAI_API_KEY", value: "..." },
    leadOnly: null,
    method: "POST",
    path: "/v1/set-env",
  }),
  create_payment_link: tool({
    body: z.strictObject({
      // the founder reads it whole in what they sign
      afterPaymentUrl: z.url().max(500).optional(),
      amountUsd: z.number().min(0.5).max(10_000),
      bet: z.string().min(1).optional(),
      // Stripe keeps a metadata value of at most 500 characters
      delivery: signedText("delivery", 500).optional(),
      name: SALE_NAME,
      product: z.string().min(1).optional(),
    }),
    doc: 'the only way to charge: creates a Stripe payment link that charges `amountUsd` once, in USD, for what `name` says, and answers with its URL. Every payment through it is tagged for your run\'s product (name another with `"product":"<slug>"`) and, with `"bet":"<slug>"`, for that revenue bet on the product while it is open or measuring, so the app counts it for both. It sells one thing once at a fixed price: no tool makes a subscription, a checkout session or a webhook, and nobody on the team holds IdleBiz\'s Stripe key. The buyer ends on Stripe\'s receipt page, unless `afterPaymentUrl` names a page of the product\'s own to send them to: https, on its production domain, deployed first. IdleBiz adds `session_id` to it, filled with the buyer\'s checkout session, and the answer names the link\'s id: the product\'s server reads that session with a key of the product\'s own and unlocks only what it reads as paid on this link (see "Checking who paid"). When a buyer is owed something only the founder can hand over (a file, a key, each issue of a newsletter), `delivery` says what the founder sends each one and where it is (a file in the workspace, a URL). Every paid checkout on the link then reaches the founder as a card with the buyer\'s email and that text, and read_orders lists it. The founder signs off on each link, its delivery and landing page included: the first call is held, and calling again once they answer creates it.',
    example: {
      amountUsd: 9,
      bet: "bet-slug",
      delivery: "Email the buyer the PDF at memos/acme-teardown.pdf in the workspace",
      name: "...",
    },
    leadOnly: null,
    method: "POST",
    path: "/v1/payment-link",
  }),
  printful_catalog: tool({
    body: z.strictObject({
      offset: z.number().int().min(0).optional(),
      product: z.number().int().positive().optional(),
    }),
    doc: `what Printful can print, read with the founder's token, which nobody on the team holds. With no body it lists ${CATALOG_PAGE} of the products Printful ships to the US, one a line (id, name, techniques); \`"offset":${CATALOG_PAGE}\` reads the next page. With \`"product":<id>\` it gives that product's placements, each with its technique, and its variants' ids with their colour and size: exactly what sell_print takes.`,
    example: { product: 71 },
    leadOnly: null,
    method: "POST",
    path: "/v1/printful-catalog",
  }),
  sell_print: tool({
    body: z.strictObject({
      bet: z.string().min(1).optional(),
      name: SALE_NAME,
      placements: z
        .array(PrintPlacementSchema)
        .min(1)
        .max(4)
        .refine(
          (placements) => new Set(placements.map((p) => p.placement)).size === placements.length,
          "name each placement once",
        ),
      priceUsd: z.number().min(1).max(1000),
      product: z.string().min(1).optional(),
      variantIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(MAX_PRINT_VARIANTS)
        .refine((ids) => new Set(ids).size === ids.length, "name each variant once"),
    }),
    doc: `sell a physical item that Printful prints on demand and ships to US addresses only. \`variantIds\` are up to ${MAX_PRINT_VARIANTS} variants of one product in Printful's catalog (its sizes or colours; the buyer picks one on the payment page), and each placement's \`placement\` and \`technique\` are ones that product offers: read them with printful_catalog, never guess. Each of \`placements\` says where a design goes (\`placement\`, such as \`front\`), how it is printed (\`technique\`, such as \`dtg\`), and \`fileUrl\`: the print file's public https URL on this product's own production domain, since Printful fetches the file from there. Deploy the file first (a PNG at print size), under a name that changes whenever the design does: the founder signs off on the file's exact bytes. \`priceUsd\` is the retail price, which the packing slip shows; the buyer also pays Printful's standard US shipping as a fixed rate. The app prices it with Printful first and refuses a price that would lose money once Printful's cost, the shipping and Stripe's fee are paid, naming the price below which every sale loses money. It then makes a Stripe payment link, tagged like create_payment_link's: for your run's product (name another with \`"product":"<slug>"\`) and, with \`"bet":"<slug>"\`, for that revenue bet on it while it is open or measuring. Each paid order goes to Printful on its own, which prints and ships it; read_orders shows them. The founder signs off on each listing: the first call is held, and calling again once they answer lists it.`,
    example: {
      bet: "bet-slug",
      name: "...",
      placements: [
        {
          fileUrl: "https://product-slug.vercel.app/print/design-1.png",
          placement: "front",
          technique: "dtg",
        },
      ],
      priceUsd: 28,
      variantIds: [4012, 4013, 4014],
    },
    leadOnly: null,
    method: "POST",
    path: "/v1/sell-print",
  }),
  read_orders: tool({
    body: z.strictObject({ product: z.string().min(1).optional() }),
    doc: "the latest paid orders on your run's product (name another with `\"product\":\"<slug>\"`), through sell_print's listings and create_payment_link's links: each buyer's email, and for a print their name and shipping address, what they bought and paid, and where it stands, so you can answer a buyer; for a retired product, where each of its payment links stands. IdleBiz sends each print to Printful itself, and hands the founder a card for each paid link that names a delivery; refunds, and anything Printful needs a person for, are the founder's, who has a card for each order that needs them.",
    example: {},
    leadOnly: null,
    method: "POST",
    path: "/v1/orders",
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
    doc: "retire a product whose bets keep dying. Its package and workspace are archived whole, its live bets die with it, and the budget goes to the others. IdleBiz switches off its payment links at Stripe, sell_print's and create_payment_link's, so it takes no new money, and hands the founder any Stripe would not switch off, and any an older IdleBiz made without keeping a record, to switch off by hand; each order already paid still ships and still counts, and read_orders still reads its orders and says where each link stands, by its slug. The last product cannot be killed: start its successor first.",
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

/** A tool as an employee is taught to call it. */
export const curlOf = (name: ToolName): string => {
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
