import { unreachable } from "@repo/domain/errors";
import { RUN_COST_ESTIMATE_USD, betMoney, hasRoomFor, isSpentOut } from "@repo/domain/bets";
import type { Bet } from "@repo/domain/bets";
import { hasRole, spriteSeedFor } from "@repo/domain/domain";
import type { BlockedAsk, Employee } from "@repo/domain/domain";
import { plural } from "@repo/domain/format";
import { publishActivity } from "../activity";
import { roomTranscript } from "../prompts/briefs";
import { RefusalError } from "../refusal";
import * as store from "../store/store";
import { TOOL_SPECS } from "../tool-specs";
import type { ToolName } from "../tool-specs";
import { askFounder, define, post, productFor } from "./define";
import type { RunContext, Tool } from "./define";

const nameOf = (id: string) => store.getEmployee(id)?.name ?? "someone";

const noRoomIn = (bet: Bet, inFlight: number) => {
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

    default: {
      return unreachable(bet.state);
    }
  }
};

const fundingFor = (ctx: RunContext, named: string | undefined, product: string | undefined) => {
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

  if (!bet) {
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

const workLoad = (e: Employee) =>
  store.openTasksFor(e.id).filter((t) => t.state.kind === "queued" || t.state.kind === "running")
    .length;

const delegateFor = (ctx: RunContext, role: string) => {
  const ready = (e: Employee) =>
    ctx.runners.signedIn(e.runner) && ctx.runners.restingRunner(e.runner) === null;

  return store
    .listEmployees()
    .filter((e) => e.id !== ctx.employee.id && hasRole(role)(e))
    .toSorted((a, b) => Number(ready(b)) - Number(ready(a)) || workLoad(a) - workLoad(b))[0];
};

export const TEAM_TOOLS = {
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
    post(ctx, text.slice(0, 400));

    return "Posted to the team room.";
  }),
  read_team_chat: define(TOOL_SPECS.read_team_chat, () =>
    roomTranscript(store.recentTeamMessages(15), nameOf),
  ),
  delegate: define(TOOL_SPECS.delegate, (ctx, { role, title, description, product, bet }) => {
    const funded = fundingFor(ctx, bet, product);
    const productId = funded?.productId ?? productFor(ctx, product);

    if (productId !== null && store.getProduct(productId) === null) {
      throw new RefusalError(store.noSuchProduct(productId));
    }

    const mate = delegateFor(ctx, role);

    if (!mate) {
      post(ctx, `(no "${role}" to delegate "${title}" to)`);
      throw new RefusalError(
        `No teammate matches the role "${role}" — do it yourself or pick another role.`,
      );
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
  request_integration: define(TOOL_SPECS.request_integration, (ctx, { kind, reason }) =>
    askFounder(
      ctx,
      {
        integration: kind,
        productId: kind === "vercel" ? ctx.run.productId : null,
        reason,
        type: "integration",
      },
      `The founder has a ${kind} connect card waiting. Continue with what you can — this task resumes automatically once connected.`,
    ),
  ),
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
        runner: ctx.runners.pickRunner(all.length),
        spriteSeed: spriteSeedFor(role, hireName),
        title,
      });
    } catch (error) {
      if (!(error instanceof RefusalError)) {
        throw error;
      }

      throw new RefusalError(
        `Couldn't hire: ${error.message}. Release someone first or work with the team you have.`,
        { cause: error },
      );
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
    const { employee } = ctx;

    if (slug === employee.id) {
      throw new RefusalError("You can't release yourself.");
    }

    const target = store.getEmployee(slug);

    if (!target) {
      throw new RefusalError(`No teammate with slug "${slug}" — check the roster in your brief.`);
    }

    if (target.status === "working") {
      throw new RefusalError(`${target.name} is mid-task right now — try again when they're idle.`);
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
} satisfies Partial<Record<ToolName, Tool>>;
