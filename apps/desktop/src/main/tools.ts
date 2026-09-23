import { z } from "zod";
import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import type { agentDriver } from "@/main/agents/agent-driver";
import { announceBet, killBet, retireProduct, startProduct } from "@/main/company-actions";
import { betLedger, betMark, roomTranscript } from "@/main/prompts/briefs";
import { RUN_COST_ESTIMATE_USD, betGoal, betMoney, hasRoomFor, isSpentOut } from "@/shared/bets";
import type { Bet } from "@/shared/bets";
import { hasRole, isLead, spriteSeedFor } from "@/shared/domain";
import type { BlockedAsk, Company, Employee } from "@/shared/domain";
import { BadRequestError, errorMessage } from "@/shared/errors";
import { plural } from "@/shared/format";
import type { JsonValue } from "@/shared/json";
import { TOOL_NAMES, TOOL_SPECS } from "@/shared/tool-specs";
import type { ToolName, ToolSpec } from "@/shared/tool-specs";

/** The first thing a run asks the founder is the one they answer; later asks in the same run are dropped. */
export interface AskBox {
  raise: (ask: BlockedAsk) => void;
  current: () => BlockedAsk | null;
}

export const askBox = (onFirst: (ask: BlockedAsk) => void): AskBox => {
  let first: BlockedAsk | null = null;
  return {
    current: () => first,
    raise: (ask) => {
      if (first === null) {
        first = ask;
        onFirst(ask);
      }
    },
  };
};

/** What a tool call acts on behalf of: who is running, for what, and the two things only the scheduler can do. */
export interface RunContext {
  employee: Employee;
  company: Company;
  run: { runId: string; taskId: string; productId: string | null; betId: string | null };
  asks: AskBox;
  driver: Pick<typeof agentDriver, "pickRunner">;
  /** Queue a task for a teammate; a busy one picks it up on a later tick. */
  assign: (taskId: string, employeeId: string) => void;
}

/** A tool ready to be called with whatever the agent sent. */
type Tool = (ctx: RunContext, raw: JsonValue) => string;

/**
 * An implementation bound to its spec, so the body it receives is the one the
 * spec parses: the lead's tools turn anyone else away, a body that does not
 * parse is the caller's error, and the store's refusals — written as the
 * sentence the agent should read — become the answer.
 */
const define =
  <B extends z.ZodType>(
    spec: ToolSpec<B>,
    run: (ctx: RunContext, body: z.infer<B>) => string,
  ): Tool =>
  (ctx, raw) => {
    if (spec.leadOnly !== null && !isLead(ctx.company, ctx.employee)) {
      return spec.leadOnly;
    }
    const body = spec.body.safeParse(raw);
    if (!body.success) {
      throw new BadRequestError(z.prettifyError(body.error));
    }
    try {
      return run(ctx, body.data);
    } catch (error) {
      return errorMessage(error);
    }
  };

const nameOf = (id: string): string => store.getEmployee(id)?.name ?? "someone";

const post = (ctx: RunContext, text: string, to: string | null = null): void => {
  store.postTeamMessage(ctx.employee.id, text);
  publishActivity({ employeeId: ctx.employee.id, kind: "chat", message: text, payload: { to } });
};

/** The product a tool means: the one it names, else the run's own, else the one waited on longest. */
const productFor = (ctx: RunContext, named: string | undefined): string | null =>
  named ?? ctx.run.productId ?? store.attentionProduct()?.id ?? null;

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
 * null only from a run no bet pays for. A bet that cannot take one more run is
 * refused, never swapped for null, so a bet's work never runs unfunded.
 */
const fundingFor = (
  ctx: RunContext,
  named: string | undefined,
  product: string | undefined,
): Bet | null => {
  const id = named ?? ctx.run.betId;
  if (id === null) {
    return null;
  }
  const bet = store.getBet(id);
  if (!bet || bet.companyId !== ctx.company.id) {
    throw new Error(`No fundable bet "${id}" — read_bets lists what is open with budget left.`);
  }
  if (named === undefined && product !== undefined && product !== bet.productId) {
    throw new Error(
      `Name a bet on ${product} with "bet":"<slug>" — read_bets lists what has room.`,
    );
  }
  const inFlight = store.runsInFlight().get(id) ?? 0;
  if (!hasRoomFor(bet, inFlight, RUN_COST_ESTIMATE_USD)) {
    throw new Error(noRoomIn(bet, inFlight));
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
      return `Couldn't hire: ${errorMessage(error)}. Release someone first or work with the team you have.`;
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
    const rehomed = store.archiveEmployee(slug)?.rehomed ?? 0;
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
    return `Released ${target.name}.${inherited} Their workspace contributions and memory are archived under alumni/.`;
  }),
} satisfies Record<ToolName, Tool>;

/** Call the tool served at `METHOD /path`; null when there is none. */
export const callTool = (ctx: RunContext, route: string, raw: JsonValue): string | null => {
  const name = TOOL_NAMES.find((n) => `${TOOL_SPECS[n].method} ${TOOL_SPECS[n].path}` === route);
  return name === undefined ? null : TOOLS[name](ctx, raw);
};
