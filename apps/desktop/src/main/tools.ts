import { z } from "zod";
import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { report } from "@/main/lib/report";
import type { AskBox, agentDriver } from "@/main/agents/agent-driver";
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
import { getSecret } from "@/main/secrets";
import { betLedger, betMark, roomTranscript } from "@/main/prompts/briefs";
import { RUN_COST_ESTIMATE_USD, betGoal, betMoney, hasRoomFor, isSpentOut } from "@/shared/bets";
import type { Bet } from "@/shared/bets";
import { hasRole, isLead, spriteSeedFor } from "@/shared/domain";
import type { Company, Employee, TaskOrigin } from "@/shared/domain";
import { BadRequestError, errorMessage } from "@/shared/errors";
import { formatUsd, plural } from "@/shared/format";
import type { HoldRuleId } from "@/shared/hold-rules";
import { RefusalError } from "@/shared/refusal";
import type { JsonValue } from "@/shared/json";
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

/**
 * Spend the founder's sign-off on `action` in this task, or ask them for it and
 * end the call. The action is the approval's key, so it reads as what is signed.
 */
const requireSignOff = (ctx: RunContext, action: string, rule: HoldRuleId): void => {
  if (store.consumeApproval(ctx.run.taskId, action)) {
    return;
  }
  ctx.asks.raise({ command: action, rule, type: "approval" });
  throw new RefusalError(
    `Held for the founder's sign-off on "${action}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
  );
};

/** What the founder signs for a deploy: the product, and the Vercel project it lands in. */
const deployAction = (productId: string, target: DeployTarget): string =>
  target.kind === "bound"
    ? `deploy ${productId} to production on Vercel project ${target.binding.projectName}`
    : `deploy ${productId} to production on a new Vercel project named ${target.name}`;

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
  ask_boss: define(TOOL_SPECS.ask_boss, (ctx, { question }) => {
    ctx.asks.raise({ question, type: "question" });
    return "Your question was sent to the founder. Note it and continue with anything you can still do.";
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
  request_integration: define(TOOL_SPECS.request_integration, (ctx, { kind, reason }) => {
    ctx.asks.raise({ integration: kind, reason, type: "integration" });
    return `The founder has a ${kind} connect card waiting. Continue with what you can — this task resumes automatically once connected.`;
  }),
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
      ctx.asks.raise({
        integration: "vercel",
        reason: `to deploy ${product.name}`,
        type: "integration",
      });
      return "Vercel is not connected: the founder has a Vercel connect card waiting. Continue with what you can — this task resumes automatically once connected.";
    }
    const target: DeployTarget =
      product.vercel === null
        ? { kind: "new", name: product.id }
        : { binding: product.vercel, kind: "bound" };
    requireSignOff(ctx, deployAction(product.id, target), "deploy");
    const deployed = await ctx.deploy({ cwd: product.workspaceDir, target, token });
    if (deployed.kind === "name-taken") {
      ctx.asks.raise({
        integration: "vercel",
        reason: `to bind ${product.name} to its Vercel project: one named "${deployed.name}" already exists`,
        type: "integration",
      });
      return `Nothing was deployed: Vercel already has a project named "${deployed.name}", and ${product.name} is not bound to it. The founder has a Vercel card waiting to bind ${product.name} to its project; this task resumes once they do. Continue with what you can.`;
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
  create_payment_link: define(
    TOOL_SPECS.create_payment_link,
    async (ctx, { amountUsd, bet, name, product: named }) => {
      const key = getSecret("STRIPE_SECRET_KEY");
      if (!key) {
        return "IdleBiz has no Stripe key to charge with: ask the founder via ask_boss to add STRIPE_SECRET_KEY, saying what you would sell and at what price. A Stripe connection only reads revenue; it cannot create payments.";
      }
      const productId = productFor(ctx, named);
      if (productId === null) {
        return "There is no product to charge for — create_product first.";
      }
      const product = store.getProduct(productId);
      if (!product) {
        return store.noSuchProduct(productId);
      }
      if (bet !== undefined) {
        const claimed = store.getBet(bet);
        if (
          claimed?.productId !== product.id ||
          claimed.claim.metric !== "revenue" ||
          claimed.state.kind !== "open"
        ) {
          return `"${bet}" is not an open revenue bet on ${product.id} — read_bets lists every live bet, what it counts and its product.`;
        }
      }
      const cents = Math.round(amountUsd * 100);
      const price = formatUsd(cents / 100);
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
      const testMode = isTestKey(key)
        ? " Stripe is in test mode: the link takes no real money, and what it takes counts for nothing unless IdleBiz runs with IDLEBIZ_COUNT_TEST_MONEY=1."
        : "";
      return `Created a payment link for "${name}" at ${price} on ${product.name}: ${made.url}${testMode}`;
    },
  ),
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
