import { unreachable } from "@repo/domain/errors";
import type { ActivityEvent } from "@repo/domain/activity";
import { INTEGRATION_LABELS } from "@repo/domain/domain";
import type { BlockedAsk, Company } from "@repo/domain/domain";

const LINE_MAX = 80;

/** How many waiting items the menu lists before it counts the rest. */
export const MENU_ASKS_SHOWN = 5;

const cut = (text: string) => {
  const line = text.replaceAll(/\s+/gu, " ").trim();

  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
};

/** One line for what an ask needs of the founder, as a notification or the menu names it. */
export const askLine = (ask: BlockedAsk, who: string) => {
  switch (ask.type) {
    case "approval": {
      return cut(`Sign off: ${ask.command}`);
    }

    case "question": {
      return cut(`${who} asks: ${ask.question}`);
    }

    case "action": {
      return cut(`${who} needs you to: ${ask.action}`);
    }

    case "integration": {
      return cut(`${who} needs ${INTEGRATION_LABELS[ask.integration]} connected`);
    }

    default: {
      return unreachable(ask);
    }
  }
};

type NameOf = (employeeId: string) => string | null;

/**
 * What a closed window tells the founder about an event, as a line, or null for one that needs
 * nothing of them. An approval a standing sign-off answers needs nothing: the room says it was.
 */
// oxlint-disable-next-line complexity -- a case a kind, so a new kind fails to compile here rather than go unheard
export const alertOf = (e: ActivityEvent, company: Company | null, nameOf: NameOf) => {
  switch (e.kind) {
    case "run.ask": {
      const { ask } = e.payload;

      const standing =
        ask.type === "approval" && company?.standingSignOffs.includes(ask.rule) === true;

      return standing ? null : askLine(ask, nameOf(e.employeeId) ?? "Your team");
    }

    case "order.card": {
      return e.payload.open ? cut(`Order card: ${e.message}`) : null;
    }

    case "budget.exhausted": {
      return "Out of budget: the office paused. Raise the cap in Budget to start it again.";
    }

    case "bet.changed": {
      const { state } = e.payload;

      if (state.kind === "won") {
        return cut(`Bet won: ${e.message}`);
      }

      return state.kind === "killed" ? cut(`Bet killed: ${e.message}`) : null;
    }

    case "task.dead": {
      return cut(`${nameOf(e.employeeId) ?? "A teammate"} gave up on a task: ${e.payload.error}`);
    }

    case "tool_call":
    case "message":
    case "chat":
    case "ship":
    case "status":
    case "run.start":
    case "run.end":
    case "task.retry":
    case "runner.resting":
    case "org.hired":
    case "org.released":
    case "product.created":
    case "product.named":
    case "product.killed":
    case "metrics.pulse":
    case "autopilot.changed": {
      return null;
    }

    default: {
      return unreachable(e);
    }
  }
};

/** One notification for the lines that came in together, so a burst posts once. */
export const noteOf = (lines: readonly [string, ...string[]]) => {
  const [first, ...rest] = lines;

  if (rest.length === 0) {
    return { body: `${first} — open IdleBiz to see it.`, title: "IdleBiz needs you" };
  }

  return {
    body: [first, ...rest].slice(0, 3).join("\n"),
    title: `${lines.length} things need you in IdleBiz`,
  };
};
