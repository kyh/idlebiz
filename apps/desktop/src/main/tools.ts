import { z } from "zod";
import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { report } from "@/main/lib/report";
import type { AskBox, agentDriver } from "@/main/agents/agent-driver";
import { unshippableIn } from "@/main/deploy";
import type { DeployTarget, Deployer } from "@/main/deploy";
import {
  announceBet,
  killBet,
  postToRoom,
  retireProduct,
  startProduct,
} from "@/main/company-actions";
import { isTestKey, measureRefusal } from "@/main/metrics";
import type { PaymentLinker } from "@/main/payment-links";
import { priceFloorCents } from "@/main/print-listing";
import type { PrintListing } from "@/main/print-listing";
import { printfulCredential } from "@/main/printful";
import type { CatalogProduct, PrintQuote, PrintfulCredential, QuoteRequest } from "@/main/printful";
import { STRIPE_SECRET_KEY, getSecret } from "@/main/secrets";
import { keepEnvValue, keptEnvValues, teamSetEnv } from "@/main/vercel-env";
import type { EnvSetter } from "@/main/vercel-env";
import { betLedger, betMark, roomTranscript } from "@/main/prompts/briefs";
import { RUN_COST_ESTIMATE_USD, betGoal, betMoney, hasRoomFor, isSpentOut } from "@/shared/bets";
import type { Bet } from "@/shared/bets";
import { hasRole, isLead, spriteSeedFor } from "@/shared/domain";
import type {
  BlockedAsk,
  Company,
  Employee,
  IntegrationKind,
  Product,
  TaskOrigin,
  VercelBinding,
} from "@/shared/domain";
import { BadRequestError, errorMessage } from "@/shared/errors";
import { formatUsd, plural } from "@/shared/format";
import type { HoldRuleId } from "@/shared/hold-rules";
import { RefusalError } from "@/shared/refusal";
import type { JsonValue } from "@/shared/json";
import { CATALOG_PAGE } from "@/shared/listing";
import type { ListedPlacement, ListingVariant, PrintPlacement } from "@/shared/listing";
import { TOOL_NAMES, TOOL_SPECS } from "@/shared/tool-specs";
import type { ToolName, ToolSpec } from "@/shared/tool-specs";

/** What a tool call acts on behalf of: who is running, for what, and what only main can do for it. */
export interface RunContext {
  employee: Employee;
  company: Company;
  run: {
    runId: string;
    taskId: string;
    productId: string | null;
    betId: string | null;
    origin: TaskOrigin;
  };
  asks: AskBox;
  driver: Pick<typeof agentDriver, "pickRunner">;
  /** Queue a task for a teammate; a busy one picks it up on a later tick. */
  assign: (taskId: string, employeeId: string) => void;
  /** Deploy with the founder's Vercel key, which the run itself never holds. */
  deploy: Deployer;
  /** Make a payment link with the founder's Stripe key, which the run itself never holds. */
  createPaymentLink: PaymentLinker;
  /** Set a product project's variable with the founder's Vercel key, which the run itself never holds. */
  setEnv: EnvSetter;
  /** List a print-on-demand item with the founder's Vercel, Printful and Stripe keys, which the run itself never holds. */
  printListing: PrintListing;
}

/** A tool ready to be called with whatever the agent sent. */
type Tool = (ctx: RunContext, raw: JsonValue) => Promise<string>;

/**
 * An implementation bound to its spec, so the body it receives is the one the
 * spec parses: the lead's tools turn anyone else away, a body that does not
 * parse is the caller's error, and the store's refusals — written as the
 * sentence the agent should read — become the answer. A fault answers too, so
 * the run can go on, but is reported.
 */
const define =
  <B extends z.ZodType>(
    spec: ToolSpec<B>,
    run: (ctx: RunContext, body: z.infer<B>) => string | Promise<string>,
  ): Tool =>
  async (ctx, raw) => {
    if (spec.leadOnly !== null && !isLead(ctx.company, ctx.employee)) {
      return spec.leadOnly;
    }
    const body = spec.body.safeParse(raw);
    if (!body.success) {
      throw new BadRequestError(z.prettifyError(body.error));
    }
    try {
      return await run(ctx, body.data);
    } catch (error) {
      if (!(error instanceof RefusalError)) {
        report(`tool ${spec.path}`, error);
      }
      return errorMessage(error);
    }
  };

const nameOf = (id: string): string => store.getEmployee(id)?.name ?? "someone";

const post = (ctx: RunContext, text: string, to: string | null = null): void => {
  postToRoom({ id: ctx.employee.id, kind: "employee" }, text, to);
};

/** The product a tool means: the one it names, else the run's own, else the one waited on longest. */
const productFor = (ctx: RunContext, named: string | undefined): string | null =>
  named ?? ctx.run.productId ?? store.attentionProduct()?.id ?? null;

const UNSENT =
  "The founder was not asked: this run already asked them something, and only a run's first ask reaches them. Note it, and try again once they answer.";

/**
 * Leave the founder `ask` and answer `sent`; or, since only a run's first ask reaches them, say
 * that this one did not, after `why` it was needed.
 */
const askFounder = (ctx: RunContext, ask: BlockedAsk, sent: string, why = ""): string =>
  ctx.asks.raise(ask) ? sent : `${why} ${UNSENT}`.trim();

/**
 * Spend the founder's sign-off on `action` in this task, or ask them for it and
 * end the call. The action is the approval's key, so it reads as what is signed.
 */
const requireSignOff = (ctx: RunContext, action: string, rule: HoldRuleId): void => {
  if (store.consumeApproval(ctx.run.taskId, action)) {
    return;
  }
  const held = `Held for the founder's sign-off on "${action}".`;
  throw new RefusalError(
    askFounder(
      ctx,
      { command: action, rule, type: "approval" },
      `${held} End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
      held,
    ),
  );
};

/** What the founder signs for a deploy: the product, and the Vercel project it lands in. */
const deployAction = (productId: string, target: DeployTarget): string =>
  target.kind === "bound"
    ? `deploy ${productId} to production on Vercel project ${target.binding.projectName}`
    : `deploy ${productId} to production on a new Vercel project named ${target.name}`;

/** Why money on `product` cannot be counted for `bet`, or null when it can. */
const revenueBetRefusal = (bet: string, product: Product): string | null => {
  const claimed = store.getBet(bet);
  return claimed?.productId === product.id &&
    claimed.claim.metric === "revenue" &&
    claimed.state.kind === "open"
    ? null
    : `"${bet}" is not an open revenue bet on ${product.id} — read_bets lists every live bet, what it counts and its product.`;
};

const TEST_MODE =
  " Stripe is in test mode: the link takes no real money, and what it takes counts for nothing unless IdleBiz runs with IDLEBIZ_COUNT_TEST_MONEY=1.";

const NO_STRIPE_KEY =
  "IdleBiz has no Stripe key to charge with: the founder has a Stripe card waiting that takes them to the Budget panel to add one. A Stripe connection only reads revenue; it cannot create payments. Continue with what you can — this task resumes automatically once the key is saved.";

const VERCEL_WAITING =
  "Vercel is not connected: the founder has a Vercel connect card waiting. Continue with what you can — this task resumes automatically once connected.";

/** Why a print file's URL is not one Printful can fetch, or null when it is. */
const fileUrlRefusal = (url: URL): string | null => {
  if (url.protocol !== "https:") {
    return `${url.href} is not https: Printful fetches a print file only from a public https URL on the product's own domain.`;
  }
  if (url.username !== "" || url.password !== "") {
    return `${url.href} carries a login: a print file has to be public, since Printful fetches it with none.`;
  }
  return null;
};

/**
 * Each placement with its file's URL as Printful will fetch it, so the file named in the
 * sign-off and the listing is that one; a URL Printful should not fetch ends the call.
 */
const printFileUrls = (placements: readonly PrintPlacement[]): PrintPlacement[] =>
  placements.map((p) => {
    const url = new URL(p.fileUrl);
    const refusal = fileUrlRefusal(url);
    if (refusal !== null) {
      throw new RefusalError(refusal);
    }
    return { ...p, fileUrl: url.href };
  });

/** Ask the founder for an integration, ending the call with what the agent should read. */
const needIntegration = (
  ctx: RunContext,
  integration: IntegrationKind,
  reason: string,
  sent: string,
  why: string,
): never => {
  throw new RefusalError(askFounder(ctx, { integration, reason, type: "integration" }, sent, why));
};

/** The founder's keys a listing is made with. */
interface SellingKeys {
  vercel: string;
  stripe: string;
  printful: PrintfulCredential;
}

/** The keys a listing is made with; the first one missing is asked for, which ends the call. */
const sellingKeys = (
  ctx: RunContext,
  product: Product,
  name: string,
  price: string,
): SellingKeys => {
  const vercel =
    getSecret("VERCEL_TOKEN") ??
    needIntegration(
      ctx,
      "vercel",
      `to check where ${product.name} serves its print files`,
      VERCEL_WAITING,
      "Vercel is not connected.",
    );
  const stripe =
    getSecret(STRIPE_SECRET_KEY) ??
    needIntegration(
      ctx,
      "stripe",
      `to sell ${JSON.stringify(name)} at ${price} through a payment link`,
      NO_STRIPE_KEY,
      "IdleBiz has no Stripe key to charge with.",
    );
  const printful =
    printfulCredential() ??
    needIntegration(
      ctx,
      "printful",
      `to print and ship ${JSON.stringify(name)}`,
      "IdleBiz has no Printful token: the founder has a Printful card waiting that takes them to the Budget panel to add one. Continue with what you can — this task resumes automatically once the token is saved.",
      "IdleBiz has no Printful token.",
    );
  return { printful, stripe, vercel };
};

/**
 * Each placement with the digest of the image the product serves at its URL on its production
 * domains right now; any other file ends the call.
 */
const servedFiles = async (
  ctx: RunContext,
  product: Product,
  binding: VercelBinding,
  token: string,
  placements: readonly PrintPlacement[],
): Promise<ListedPlacement[]> => {
  const read = await ctx.printListing.hosts(binding, token);
  if (read.kind === "refused") {
    return needIntegration(
      ctx,
      "vercel",
      `Vercel turned IdleBiz's token away while checking ${product.name}'s domains`,
      "Vercel turned IdleBiz's token away: the founder has a Vercel card waiting to connect it again. Continue with what you can — this task resumes automatically once connected.",
      "Vercel turned IdleBiz's token away.",
    );
  }
  if (read.kind === "unreachable") {
    throw new RefusalError(
      `Vercel could not say where ${product.name} is served (${read.reason}); try again.`,
    );
  }
  const served: ListedPlacement[] = [];
  for (const placement of placements) {
    const { fileUrl } = placement;
    if (!read.hosts.includes(new URL(fileUrl).hostname)) {
      const domains = read.hosts.length === 0 ? "none yet" : read.hosts.join(", ");
      throw new RefusalError(
        `${fileUrl} is not on ${product.name}'s production domains (${domains}): Printful prints only a file the product itself serves, so deploy it there and name that URL.`,
      );
    }
    const file = await ctx.printListing.readFile(fileUrl);
    if (file.kind === "unfit") {
      throw new RefusalError(
        `Printful could not fetch ${fileUrl}: ${file.reason}. Deploy the print file first, and check it loads as an image.`,
      );
    }
    served.push({ ...placement, sha256: file.sha256 });
  }
  return served;
};

/** Ask the founder for a Printful token in place of one Printful turned away, which ends the call. */
const printfulTurnedAway = (ctx: RunContext): never =>
  needIntegration(
    ctx,
    "printful",
    "Printful turned IdleBiz's token away (tokens expire): paste a new one",
    "Printful turned IdleBiz's token away, which happens when it expires: the founder has a Printful card waiting to paste a new one. Continue with what you can — this task resumes automatically once it is saved.",
    "Printful turned IdleBiz's token away.",
  );

/** Printful's price for a listing; a token it turns away is asked for anew, which ends the call. */
const quotePrint = async (ctx: RunContext, req: QuoteRequest): Promise<PrintQuote> => {
  const quoted = await ctx.printListing.quote(req);
  switch (quoted.kind) {
    case "quoted": {
      return quoted.quote;
    }
    case "refused": {
      return printfulTurnedAway(ctx);
    }
    case "failed": {
      throw new RefusalError(`Printful could not price it: ${quoted.reason}`);
    }
    // no default
  }
};

/** End the call unless the founder's Stripe key can make the listing's shipping rate. */
const requireShippingAccess = async (ctx: RunContext, key: string): Promise<void> => {
  const access = await ctx.printListing.shippingAccess(key);
  switch (access.kind) {
    case "granted": {
      return;
    }
    case "refused": {
      return needIntegration(
        ctx,
        "stripe",
        `Stripe won't let IdleBiz's key make shipping rates, which listing a print needs (${access.said}): remove the key and paste one whose restricted permissions include Write on Shipping Rates, or your secret key`,
        "Stripe won't let IdleBiz's key make shipping rates: the founder has a Stripe card waiting to replace the key. Continue with what you can — this task resumes automatically once it is saved.",
        "Stripe won't let IdleBiz's key make shipping rates.",
      );
    }
    case "unreachable": {
      throw new RefusalError(
        `Stripe could not be asked about shipping rates (${access.reason}); try again.`,
      );
    }
    // no default
  }
};

const NO_FULFILMENT =
  "IdleBiz does not send paid orders to Printful yet, so sell_print lists only on a test-mode Stripe key, and the founder's is live: a live link would take a buyer's money for an item nobody ships. Sell what create_payment_link can for now.";

/** One page of Printful's catalog, a product a line, with how to read the next. */
const catalogPage = ({
  offset,
  products,
  total,
}: {
  offset: number;
  products: readonly CatalogProduct[];
  total: number;
}): string => {
  if (offset >= total) {
    return `Printful's catalog lists ${total} products that ship to the US, so none from ${offset + 1}.`;
  }
  const next = offset + CATALOG_PAGE;
  const more = next < total ? ` Pass "offset":${next} for the next page.` : "";
  const lines = products.map((p) => {
    const made = [p.brand, p.model].filter(Boolean).join(" ");
    const how = p.techniques.map((t) => t.key).join(", ");
    return `${p.id}: ${p.name}${made ? ` (${made})` : ""}${how ? ` — ${how}` : ""}`;
  });
  return `Printful's catalog, from product ${offset + 1} of ${total} that ship to the US (id: name — techniques; discontinued ones left out). Pass "product":<id> for its placements and variants.${more}\n${lines.join("\n")}`;
};

/** A catalog product as sell_print names it: its placements with their techniques, and its variants. */
const catalogProduct = (product: CatalogProduct, variants: readonly ListingVariant[]): string => {
  const placements = product.placements.map((p) => `${p.placement} (${p.technique})`);
  return `${product.id}: ${product.name}${product.is_discontinued === true ? " — discontinued, so it cannot be ordered" : ""}
Placements, as sell_print's placement (technique): ${placements.join(", ") || "none listed"}
Variants, as sell_print's variantIds (id: colour / size):
${variants.map((v) => `${v.id}: ${v.label}`).join("\n")}`;
};

/** Why a bet takes no more work, in the words the agent should act on. */
const noRoomIn = (bet: Bet, inFlight: number): string => {
  switch (bet.state.kind) {
    case "open": {
      return isSpentOut(bet)
        ? `"${bet.title}" is spent out: measure_bet or kill_bet it, or name another bet with "bet":"<slug>".`
        : `"${bet.title}" has no room for another run: ${betMoney(bet)} spent and ${inFlight} in flight. Do it yourself, or name another bet with "bet":"<slug>".`;
    }
    case "measuring": {
      return `"${bet.title}" is measuring: its clock is running; no more work is spent on it.`;
    }
    case "won":
    case "killed": {
      return `"${bet.title}" is closed: no more work is spent on it.`;
    }
    // no default
  }
};

/**
 * The bet delegated work spends against: the one named, else the run's own;
 * null only from a founder ping, a routine or what they delegate. A proposal
 * has no bet yet, but what it delegates is work for the bet it opens, so it
 * must name that one. A bet that cannot take one more run is refused, never
 * swapped for null, so a bet's work never runs unfunded.
 */
const fundingFor = (
  ctx: RunContext,
  named: string | undefined,
  product: string | undefined,
): Bet | null => {
  const id = named ?? ctx.run.betId;
  if (id === null) {
    if (ctx.run.origin === "propose") {
      throw new RefusalError(
        'The team only spends against bets: open_bet first, then delegate with "bet":"<slug>".',
      );
    }
    return null;
  }
  const bet = store.getBet(id);
  if (!bet || bet.companyId !== ctx.company.id) {
    throw new RefusalError(
      `No fundable bet "${id}" — read_bets lists what is open with budget left.`,
    );
  }
  if (named === undefined && product !== undefined && product !== bet.productId) {
    throw new RefusalError(
      `Name a bet on ${product} with "bet":"<slug>" — read_bets lists what has room.`,
    );
  }
  const inFlight = store.runsInFlight().get(id) ?? 0;
  if (!hasRoomFor(bet, inFlight, RUN_COST_ESTIMATE_USD)) {
    throw new RefusalError(noRoomIn(bet, inFlight));
  }
  return bet;
};

// oxlint-disable-next-line sort-keys -- the order of TOOL_SPECS
const TOOLS = {
  ask_boss: define(TOOL_SPECS.ask_boss, (ctx, body) => {
    const ask: BlockedAsk =
      "question" in body
        ? { question: body.question, type: "question" }
        : {
            action: body.action,
            draft: body.draft,
            instructions: body.instructions,
            type: "action",
          };
    return askFounder(
      ctx,
      ask,
      ask.type === "question"
        ? "Your question was sent to the founder. Note it and continue with anything you can still do."
        : "The founder has your action card. Note it and continue with anything that does not wait on it.",
    );
  }),
  message_team: define(TOOL_SPECS.message_team, (ctx, { text }) => {
    // Free-form chat is capped here, not in the room: every teammate's brief reads it.
    post(ctx, text.slice(0, 400));
    return "Posted to the team room.";
  }),
  read_team_chat: define(TOOL_SPECS.read_team_chat, () =>
    roomTranscript(store.recentTeamMessages(15), nameOf),
  ),
  delegate: define(TOOL_SPECS.delegate, (ctx, { role, title, description, product, bet }) => {
    const { company, employee } = ctx;
    const funded = fundingFor(ctx, bet, product);
    const productId = funded?.productId ?? productFor(ctx, product);
    if (productId !== null && store.getProduct(productId)?.companyId !== company.id) {
      return store.noSuchProduct(productId);
    }
    const mate = store
      .listEmployees()
      .filter((e) => e.id !== employee.id)
      .find(hasRole(role));
    if (!mate) {
      post(ctx, `(no "${role}" to delegate "${title}" to)`);
      return `No teammate matches the role "${role}" — do it yourself or pick another role.`;
    }
    const task = store.createTask({
      assigneeId: mate.id,
      betId: funded?.id ?? null,
      description,
      origin: "delegated",
      priority: "medium",
      productId,
      title,
    });
    post(ctx, `→ ${mate.name} (${mate.title}): ${title}`, mate.id);
    ctx.assign(task.id, mate.id);
    return `Delegated "${title}" to ${mate.name} (${mate.title}). They'll report back in the team room.`;
  }),
  read_bets: define(TOOL_SPECS.read_bets, () => betLedger(store.listBets())),
  request_integration: define(TOOL_SPECS.request_integration, (ctx, { kind, reason }) =>
    askFounder(
      ctx,
      { integration: kind, reason, type: "integration" },
      `The founder has a ${kind} connect card waiting. Continue with what you can — this task resumes automatically once connected.`,
    ),
  ),
  deploy: define(TOOL_SPECS.deploy, async (ctx, { product: named }) => {
    const productId = productFor(ctx, named);
    if (productId === null) {
      return "There is no product to deploy — create_product first.";
    }
    const product = store.getProduct(productId);
    if (!product) {
      return store.noSuchProduct(productId);
    }
    const token = getSecret("VERCEL_TOKEN");
    if (!token) {
      return askFounder(
        ctx,
        { integration: "vercel", reason: `to deploy ${product.name}`, type: "integration" },
        VERCEL_WAITING,
        "Vercel is not connected.",
      );
    }
    const target: DeployTarget =
      product.vercel === null
        ? { kind: "new", name: product.id }
        : { binding: product.vercel, kind: "bound" };
    const unshippable = keptEnvValues();
    const leak = await unshippableIn(product.workspaceDir, unshippable);
    if (leak !== null) {
      return leak;
    }
    requireSignOff(ctx, deployAction(product.id, target), "deploy");
    const deployed = await ctx.deploy({ cwd: product.workspaceDir, target, token, unshippable });
    if (deployed.kind === "name-taken") {
      const refused = `Nothing was deployed: Vercel already has a project named "${deployed.name}", and ${product.name} is not bound to it.`;
      return askFounder(
        ctx,
        {
          integration: "vercel",
          reason: `to bind ${product.name} to its Vercel project: one named "${deployed.name}" already exists`,
          type: "integration",
        },
        `${refused} The founder has a Vercel card waiting to bind ${product.name} to its project; this task resumes once they do. Continue with what you can.`,
        refused,
      );
    }
    // a new project exists from its first deployment on, live or not
    const made = target.kind === "new" ? deployed.project : null;
    const binds = made !== null && store.getProduct(product.id)?.vercel === null ? made : null;
    if (binds !== null) {
      store.setProductVercel(product.id, binds);
    }
    const bindNote =
      binds === null
        ? ""
        : `\n${product.name} is now bound to the new Vercel project ${binds.projectName}, which counts its visitors.`;
    if (deployed.kind === "failed") {
      return `The deploy of ${product.name} failed: ${deployed.reason}${bindNote}`;
    }
    const live =
      deployed.alias === null
        ? deployed.url
        : `${deployed.alias} (this deployment: ${deployed.url})`;
    return `Deployed ${product.name} to production: ${live}${bindNote}`;
  }),
  set_env: define(TOOL_SPECS.set_env, async (ctx, { name, value, product: named }) => {
    const productId = productFor(ctx, named);
    if (productId === null) {
      return "There is no product to set it on — create_product first.";
    }
    const product = store.getProduct(productId);
    if (!product) {
      return store.noSuchProduct(productId);
    }
    if (product.vercel === null) {
      return `${product.name} has no Vercel project yet: deploy it first, which makes one, then set ${name}.`;
    }
    const token = getSecret("VERCEL_TOKEN");
    if (!token) {
      return askFounder(
        ctx,
        { integration: "vercel", reason: `to set ${name} on ${product.name}`, type: "integration" },
        VERCEL_WAITING,
        "Vercel is not connected.",
      );
    }
    const replaces = teamSetEnv(product, name);
    const set = await ctx.setEnv({ binding: product.vercel, name, replaces, token, value });
    if (!set.ok) {
      const notOurs = replaces
        ? ""
        : `\nset_env only replaces a variable the team set: if ${product.vercel.projectName} already has ${name}, it is the founder's, so hand them an ask_boss action to change it.`;
      return `${name} was not set on ${product.name}: ${set.error}${notOurs}`;
    }
    keepEnvValue(product, name, value);
    post(ctx, `🔑 set ${name} on ${product.name}`);
    return `Set ${name} on ${product.name}'s Vercel project ${product.vercel.projectName}, for production and preview. It takes effect on the next deploy; server code reads it as process.env.${name}. Never write its value into a file: deploy refuses a folder that holds it.`;
  }),
  create_payment_link: define(
    TOOL_SPECS.create_payment_link,
    async (ctx, { amountUsd, bet, name, product: named }) => {
      const productId = productFor(ctx, named);
      if (productId === null) {
        return "There is no product to charge for — create_product first.";
      }
      const product = store.getProduct(productId);
      if (!product) {
        return store.noSuchProduct(productId);
      }
      const notTheBet = bet === undefined ? null : revenueBetRefusal(bet, product);
      if (notTheBet !== null) {
        return notTheBet;
      }
      const cents = Math.round(amountUsd * 100);
      const price = formatUsd(cents / 100);
      const key = getSecret(STRIPE_SECRET_KEY);
      if (!key) {
        return askFounder(
          ctx,
          {
            integration: "stripe",
            reason: `to sell ${JSON.stringify(name)} at ${price} through a payment link`,
            type: "integration",
          },
          NO_STRIPE_KEY,
          "IdleBiz has no Stripe key to charge with.",
        );
      }
      // quoted as JSON, so a name cannot pose as more of the action the founder signs
      const action = `payment link ${JSON.stringify(name)} at ${price} on ${product.id}${bet === undefined ? "" : ` for bet ${bet}`}`;
      requireSignOff(ctx, action, "payments");
      const made = await ctx.createPaymentLink({
        bet: bet ?? null,
        cents,
        key,
        name,
        product: product.id,
      });
      if (!made.ok) {
        return `Stripe made no payment link: ${made.error}`;
      }
      const testMode = isTestKey(key) ? TEST_MODE : "";
      return `Created a payment link for "${name}" at ${price} on ${product.name}: ${made.url}${testMode}`;
    },
  ),
  printful_catalog: define(TOOL_SPECS.printful_catalog, async (ctx, { offset, product }) => {
    const credential =
      printfulCredential() ??
      needIntegration(
        ctx,
        "printful",
        "to read Printful's catalog for what to sell",
        "IdleBiz has no Printful token: the founder has a Printful card waiting that takes them to the Budget panel to add one. Continue with what you can — this task resumes automatically once the token is saved.",
        "IdleBiz has no Printful token.",
      );
    const read = await ctx.printListing.catalog(
      product === undefined ? { offset: offset ?? 0 } : { product },
      credential,
    );
    switch (read.kind) {
      case "products": {
        return catalogPage(read);
      }
      case "product": {
        return catalogProduct(read.product, read.variants);
      }
      case "refused": {
        return printfulTurnedAway(ctx);
      }
      case "failed": {
        return `Printful's catalog could not be read: ${read.reason}`;
      }
      // no default
    }
  }),
  sell_print: define(TOOL_SPECS.sell_print, async (ctx, body) => {
    const { bet, name, priceUsd, variantIds, product: named } = body;
    const productId = productFor(ctx, named);
    if (productId === null) {
      return "There is no product to sell it on — create_product first.";
    }
    const product = store.getProduct(productId);
    if (!product) {
      return store.noSuchProduct(productId);
    }
    const notTheBet = bet === undefined ? null : revenueBetRefusal(bet, product);
    if (notTheBet !== null) {
      return notTheBet;
    }
    const urls = printFileUrls(body.placements);
    if (product.vercel === null) {
      return `${product.name} has no Vercel project yet: deploy it with the print file, which makes one, then list it.`;
    }
    const priceCents = Math.round(priceUsd * 100);
    const price = formatUsd(priceCents / 100);
    const keys = sellingKeys(ctx, product, name, price);
    if (!isTestKey(keys.stripe)) {
      return NO_FULFILMENT;
    }
    const placements = await servedFiles(ctx, product, product.vercel, keys.vercel, urls);
    const quote = await quotePrint(ctx, { credential: keys.printful, placements, variantIds });
    const floor = priceFloorCents(quote);
    const shipping = formatUsd(quote.shippingCents / 100);
    if (priceCents < floor) {
      return `${price} would lose money on every sale: Printful charges up to ${formatUsd(quote.costCents / 100)} to print one and ship it in the US, the buyer pays ${shipping} of that as shipping, and Stripe keeps up to 4.4% + $0.30. The lowest price that loses nothing is ${formatUsd(floor / 100)}: price it above that, with the margin the bet needs.`;
    }
    await requireShippingAccess(ctx, keys.stripe);
    // the digest pins the design the founder signs for: a later deploy can change what the URL serves
    const printed = placements
      .map((p) => `${p.placement} (${p.technique}) ${p.fileUrl} sha256:${p.sha256}`)
      .join(", ");
    // quoted as JSON, so a name cannot pose as more of the action the founder signs
    const action = `sell ${JSON.stringify(name)} (variants ${variantIds.join(", ")}) printing ${printed} at ${price} via Printful on ${product.id}${bet === undefined ? "" : ` for bet ${bet}`}`;
    requireSignOff(ctx, action, "payments");
    const listingId = store.newListingId(product.id, name);
    const made = await ctx.printListing.publish({
      bet: bet ?? null,
      key: keys.stripe,
      listing: listingId,
      name,
      priceCents,
      product: product.id,
      shippingCents: quote.shippingCents,
      variants: quote.variants,
    });
    if (!made.ok) {
      return `Stripe made no payment link: ${made.error}`;
    }
    store.recordListing({
      betId: bet ?? null,
      costCents: quote.costCents,
      createdAt: Date.now(),
      id: listingId,
      livemode: !isTestKey(keys.stripe),
      name,
      paymentLink: { id: made.id, url: made.url },
      placements,
      priceCents,
      productId: product.id,
      shippingCents: quote.shippingCents,
      variants: quote.variants,
    });
    post(ctx, `🛍️ listed "${name}" at ${price} on ${product.name}`);
    return `Listed "${name}" on ${product.name} at ${price} plus ${shipping} shipping, US addresses only: ${made.url}\nPrintful charges up to ${formatUsd(quote.costCents / 100)} for each one it prints and ships.${TEST_MODE}`;
  }),
  create_product: define(TOOL_SPECS.create_product, (ctx, { name, description }) => {
    const product = startProduct({ description, name }, ctx.employee.id);
    post(ctx, `🆕 New product: ${product.name} — ${product.description}`);
    return `Created "${product.name}" (${product.id}); its workspace is ${product.workspaceDir}. Fund work on it with open_bet and "product":"${product.id}", then delegate against that bet.`;
  }),
  kill_product: define(TOOL_SPECS.kill_product, (ctx, { slug, reason }) => {
    const retired = retireProduct(slug, reason, ctx.employee.id);
    return `Retired ${retired.name}. Its package is archived under retired/; its deploy, if any, is still live until someone takes it down.`;
  }),
  open_bet: define(TOOL_SPECS.open_bet, (ctx, { product, ...bet }) => {
    const productId = productFor(ctx, product);
    if (productId === null) {
      return "There is no product to bet on — create_product first.";
    }
    const wager = bet.metric === "users" ? { ...bet, landingPath: bet.landingPath ?? null } : bet;
    const opened = store.openBet({ ...wager, productId });
    announceBet(opened);
    return `Opened "${opened.title}" (${opened.id}). ${betMark(opened)} Delegate work to it with "bet":"${opened.id}"; idle teammates pick it up on their own.`;
  }),
  measure_bet: define(TOOL_SPECS.measure_bet, (_ctx, { slug }) => {
    const named = store.getBet(slug);
    const refusal =
      named?.state.kind === "open"
        ? measureRefusal(named, store.getProduct(named.productId))
        : null;
    if (refusal !== null) {
      return refusal;
    }
    const bet = store.measureBet(slug, Date.now());
    announceBet(bet);
    return `"${bet.title}" is measuring: no more work is spent on it, and it has ${bet.windowHours}h to bring in ${betGoal(bet)}.`;
  }),
  kill_bet: define(TOOL_SPECS.kill_bet, (_ctx, { slug, reason }) => {
    const killed = killBet(slug, reason);
    return `Killed "${killed.title}". Its remaining budget is free for the next bet.`;
  }),
  hire: define(TOOL_SPECS.hire, (ctx, { role, title, name, persona }) => {
    const { employee } = ctx;
    const all = store.listEmployees();
    const hireName = name ?? `${title} ${all.length + 1}`;
    let hired: Employee;
    try {
      hired = store.createEmployee({
        deskIndex: all.length,
        name: hireName,
        persona: persona ?? `A focused, pragmatic ${title} who ships.`,
        role,
        runner: ctx.driver.pickRunner(all.length),
        spriteSeed: spriteSeedFor(role, hireName),
        title,
      });
    } catch (error) {
      if (!(error instanceof RefusalError)) {
        throw error;
      }
      return `Couldn't hire: ${error.message}. Release someone first or work with the team you have.`;
    }
    post(ctx, `🤝 hired ${hired.name} (${title})`);
    publishActivity({
      employeeId: hired.id,
      kind: "org.hired",
      payload: { by: employee.id, name: hired.name, title },
    });
    return `Hired ${hired.name} (${title}) — slug "${hired.id}". They start picking up work autonomously; delegate to them right away if you have something specific.`;
  }),
  release: define(TOOL_SPECS.release, (ctx, { slug, reason }) => {
    const { company, employee } = ctx;
    if (slug === employee.id) {
      return "You can't release yourself.";
    }
    const target = store.getEmployee(slug);
    if (!target || target.companyId !== company.id) {
      return `No teammate with slug "${slug}" — check the roster in your brief.`;
    }
    if (target.status === "working") {
      return `${target.name} is mid-task right now — try again when they're idle.`;
    }
    const left = store.archiveEmployee(slug);
    const rehomed = left?.rehomed ?? 0;
    const dropped = left?.dropped ?? 0;
    post(ctx, `👋 ${target.name} was released${reason ? ` — ${reason}` : ""}`);
    publishActivity({
      employeeId: target.id,
      kind: "org.released",
      payload: { by: employee.id, name: target.name, reason },
    });
    const inherited =
      rehomed === 0
        ? ""
        : ` Their open work is yours now: ${plural(rehomed, "task")}, each waiting in the founder's Inbox for an answer or a retry.`;
    const lost =
      dropped === 0
        ? ""
        : ` Dropped ${plural(dropped, "task")} of theirs — delegate again whatever still matters.`;
    return `Released ${target.name}.${inherited}${lost} Their workspace contributions and memory are archived under alumni/.`;
  }),
} satisfies Record<ToolName, Tool>;

/** Call the tool served at `METHOD /path`; null when there is none. */
export const callTool = (
  ctx: RunContext,
  route: string,
  raw: JsonValue,
): Promise<string | null> => {
  const name = TOOL_NAMES.find((n) => `${TOOL_SPECS[n].method} ${TOOL_SPECS[n].path}` === route);
  return name === undefined ? Promise.resolve(null) : TOOLS[name](ctx, raw);
};
