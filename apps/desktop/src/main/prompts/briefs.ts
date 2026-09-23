import { RUN_COST_ESTIMATE_USD, betGoal, betMoney, betProgress, ledgerOrder } from "@/shared/bets";
import type { Bet } from "@/shared/bets";
import { INTEGRATION_LABELS, businessTypeById, isLead, serializeBlockedAsk } from "@/shared/domain";
import type {
  BlockedAsk,
  Company,
  Employee,
  IntegrationKind,
  Product,
  Routine,
  RunMetrics,
  Task,
  TeamMessage,
} from "@/shared/domain";
import { formatUsd } from "@/shared/format";

export interface TaskBrief {
  title: string;
  description: string;
}

export const roomTranscript = (
  messages: readonly TeamMessage[],
  nameOf: (id: string) => string,
): string =>
  messages
    .map(
      (message) =>
        `- ${message.fromEmployeeId ? nameOf(message.fromEmployeeId) : "founder"}: ${message.text}`,
    )
    .join("\n") || "(no messages yet)";

/** The live numbers the founder's HUD shows, so a run can steer by them.
 *  Null is "no source connected", never zero: the difference decides whether
 *  the next move is growth or asking for the connection. */
/** "; +$2.00 since your last run" — how a live number moved, when the previous run recorded one. */
const movedBy = (now: number, then: number | null | undefined, money: boolean): string => {
  if (then === null || then === undefined) {
    return "";
  }
  const delta = now - then;
  if (delta === 0) {
    return "; unchanged since your last run";
  }
  const shown = money ? formatUsd(Math.abs(delta)) : `${Math.abs(delta)}`;
  return `; ${delta > 0 ? "+" : "−"}${shown} since your last run`;
};

const realNumbers = (
  company: Company,
  products: readonly Product[],
  since: RunMetrics | null,
): string => {
  const revenue =
    company.revenueUsd === null
      ? '- Revenue: no source connected (Stripe) — nothing is being charged yet; request_integration "stripe" when there is something to charge for.'
      : `- Revenue: ${formatUsd(company.revenueUsd)} lifetime (Stripe, live${movedBy(company.revenueUsd, since?.revenueUsd, true)}).`;
  const users =
    company.users === null
      ? '- Users: no source connected — nobody can see traffic; a product deployed on Vercel reports visitors (request_integration "vercel").'
      : `- Users: ${company.users} visitors across products (Vercel Web Analytics, live${movedBy(company.users, since?.users, false)}).`;
  const perProduct = products
    .filter((p) => p.users !== null)
    .map((p) => `  - ${p.name}: ${p.users} visitors`)
    .join("\n");
  return [revenue, users, perProduct].filter((line) => line.length > 0).join("\n");
};

const budgetLine = (company: Company): string => {
  if (company.budget.mode !== "capped") {
    return `AI spend so far: ${formatUsd(company.spentUsd)} (no cap set).`;
  }
  return `AI budget: ${formatUsd(company.spentUsd)} of ${formatUsd(company.budget.capUsd)} spent.`;
};

/** What the allocator decided this run is for: an `Allocation` with its ids resolved. */
export type Assignment =
  | { kind: "work"; bet: Bet }
  /** The bet's budget is gone: the lead starts its clock or kills it. */
  | { kind: "settle"; bet: Bet }
  /** Nothing is fundable, so the lead opens the next bet: on `product`, or on new ground when `widen`. */
  | { kind: "propose"; product: Product | null; widen: boolean };

const betLine = (bet: Bet): string => {
  const st = bet.state;
  const head = `- ${bet.title} (${bet.id}) on ${bet.productId}: ${betGoal(bet)} (${betProgress(bet)}), ${betMoney(bet)} spent`;
  switch (st.kind) {
    case "open": {
      return `${head} — open`;
    }
    case "measuring": {
      return `${head} — measuring until ${new Date(st.until).toISOString()}`;
    }
    case "won": {
      return `${head} — WON (moved ${st.moved})`;
    }
    case "killed": {
      return `${head} — KILLED (${st.reason})`;
    }
    // no default
  }
};

/** How a bet's result gets counted: the one thing its work must never skip. */
export const betMark = (bet: Bet): string =>
  bet.claim.metric === "users"
    ? `It counts only visitors who land on ${bet.claim.landingPath} (or a page under it) of ${bet.productId}'s deploy: every link this bet places anywhere must point there, and the path must serve a real page — see "Marking a bet's traffic" in your instructions.`
    : `It counts only Stripe money tagged metadata[bet]=${bet.id}: every payment link, checkout session or payment intent made for it must carry that tag on the payment itself.`;

/** What the team room hears when a bet opens or changes state. */
export const betNews = (bet: Bet): string => {
  const st = bet.state;
  switch (st.kind) {
    case "open": {
      return `🎲 New bet: ${bet.title} — ${bet.hypothesis}`;
    }
    case "measuring": {
      return `⏳ ${bet.title}: spending stopped — the number has ${bet.windowHours}h to answer.`;
    }
    case "won": {
      return `🏆 Bet won: ${bet.title} — it brought in ${betProgress(bet)} ${bet.claim.metric}.`;
    }
    case "killed": {
      return `🪦 Bet killed: ${bet.title} — ${st.reason}.`;
    }
    // no default
  }
};

/** How many verdicts a brief lists. Facts only: what was bet, what it cost, what the number did. */
const VERDICTS_SHOWN = 6;

/** The ledger as the team reads it, in the brief and from read_bets. */
export const betLedger = (bets: readonly Bet[]): string =>
  ledgerOrder(bets, VERDICTS_SHOWN).map(betLine).join("\n") || "(no bets yet)";

/** How one assignment reads in a brief: its title, the product it lands on, and what it asks for. */
interface AssignmentBrief {
  title: string;
  focus: Product | null;
  lines: string[];
}

const assignmentBrief = (
  assignment: Assignment,
  {
    company,
    products,
    isLeader,
  }: { company: Company; products: readonly Product[]; isLeader: boolean },
): AssignmentBrief => {
  switch (assignment.kind) {
    case "work": {
      const { bet } = assignment;
      return {
        focus: products.find((p) => p.id === bet.productId) ?? null,
        lines: [
          `THIS RUN SPENDS AGAINST A BET: "${bet.title}" (${bet.id}).`,
          `Hypothesis: ${bet.hypothesis}`,
          `It wins only if it brings in ${betGoal(bet)} (so far: ${betProgress(bet)}) — the app judges that from the live number, not from what anyone reports. ${betMark(bet)}`,
          `${betMoney(bet)} of its budget is spent; when the budget runs out the work stops. Once the lead calls the work live, the number gets ${bet.windowHours}h to answer.`,
          `If the next step is waiting on the founder (a connection, an approval) and a teammate has already asked, do not ask again: do what can be done without it, or stop.`,
          `Do the one thing most likely to move that number. Shipping is not the goal; the number is.`,
          isLeader
            ? `When the work that could move it is out the door, call measure_bet so the spending stops and the clock starts. If the bet is plainly dead, kill_bet and say why.`
            : `If you believe the work that could move it is already out the door, tell the lead in the team room.`,
        ],
        title: `Bet: ${bet.title}`,
      };
    }
    case "settle": {
      const { bet } = assignment;
      return {
        focus: products.find((p) => p.id === bet.productId) ?? null,
        lines: [
          `A BET IS OUT OF BUDGET AND NEEDS YOUR CALL: "${bet.title}" (${bet.id}) has spent ${betMoney(bet)} and brought in ${betProgress(bet)}. Nobody works on it until you decide.`,
          `If the work that could move the number is really out the door — deployed, posted, reachable — call measure_bet: it then has ${bet.windowHours}h to bring in ${betGoal(bet)}.`,
          `If it is not, a clock would only produce a false verdict: kill_bet with the honest reason, and if the hypothesis still deserves a test, open it again with a budget that covers the work.`,
          `Decide this run. Do not do the work yourself here.`,
        ],
        title: `Settle the bet: ${bet.title}`,
      };
    }
    case "propose": {
      const { product, widen } = assignment;
      const where = product
        ? `${product.name} (${product.id}) has room for one`
        : "every product already carries all the live bets it can";
      return {
        focus: product,
        lines: [
          `NOTHING IS FUNDED RIGHT NOW: the team only spends against bets, and no open bet has budget left. Opening the next one is your job this run.`,
          widen
            ? `Go somewhere new: a product the company does not have yet (create_product, then bet on it) or a channel it has never tried — ${where}.`
            : `${where}.`,
          `Call open_bet with a falsifiable hypothesis, what it should bring in ("users" or "revenue") and how much of it, a budget cap in USD small enough to lose, and how many hours the number gets to answer. One teammate run costs about ${formatUsd(RUN_COST_ESTIMATE_USD)}, so a budget that covers fewer than three runs buys almost nothing; spending it out stops the work but does not start the clock — you do, with measure_bet, once the work is really live. Then delegate the first pieces of work to it with "bet":"<slug>".`,
          `A product whose bets keep dying is a candidate for kill_product: its package is archived, its budget goes to the others.`,
        ],
        title: `Open the next bet for ${product?.name ?? company.name}`,
      };
    }
    // no default
  }
};

export interface AutonomousBriefInput {
  company: Company;
  employee: Employee;
  products: readonly Product[];
  assignment: Assignment;
  bets: readonly Bet[];
  employees: readonly Employee[];
  room: readonly TeamMessage[];
  /** Summaries of recent ships, newest last. */
  ships: readonly string[];
  /** Dead-lettered tasks worth a second look. */
  problems: readonly Task[];
  nameOf: (id: string) => string;
}

export const autonomousBrief = (input: AutonomousBriefInput): TaskBrief => {
  const {
    company,
    employee,
    employees,
    products,
    assignment,
    bets,
    room,
    ships,
    problems,
    nameOf,
  } = input;
  const isLeader = isLead(company, employee);
  const { title, focus, lines } = assignmentBrief(assignment, { company, isLeader, products });
  const portfolio = products
    .map((p) => `- ${p.name} (${p.id}): ${p.description}${p === focus ? " ← this run" : ""}`)
    .join("\n");
  const roster =
    employees
      .map((e) => `${e.name} (${e.title})${company.leaderId === e.id ? " — lead" : ""}`)
      .join(", ") || "(just you)";
  const shipped = ships.map((s) => `- ${s}`).join("\n") || "(nothing shipped yet)";
  const failures =
    problems
      .map(
        (t) =>
          `- ${t.title}${t.state.kind === "dead" ? ` (last error: ${t.state.lastError})` : ""}`,
      )
      .join("\n") || "(none)";
  const budget = budgetLine(company);

  const coordinate = isLeader
    ? `You LEAD the team. Your job is to coordinate: decide the most valuable next outcome, then either do one focused chunk yourself or break it up and hand pieces to teammates — use the delegate tool once for a single handoff, or several times to fan work out in parallel. Keep everyone moving and unblocked.
You also OWN headcount (hard cap ${company.maxAgents} seats, ${employees.length} filled): hire when the backlog demands a role you don't have (hire tool — give role, title, name, persona), release teammates whose role stopped pulling weight (release tool — their work is archived, not lost). Size the team to the budget: more people burn money faster. ${budget}`
    : `You're on the team${company.leaderId ? `, led by ${nameOf(company.leaderId)}` : ""}. Check the team room first with read_team_chat, pick up what your role should own, and execute it. If something is better owned by another role, hand it off with the delegate tool. ${budget}`;

  const description = [
    `You are operating autonomously to grow ${company.name}.`,
    `Mission: ${company.mission}`,
    `Business type: ${businessTypeById(company.businessType).label}.`,
    `Your role: ${employee.title}.`,
    `Your team: ${roster}.`,
    ``,
    `Products:`,
    portfolio,
    ``,
    ...lines,
    ``,
    `Bets (live first, then the latest verdicts):`,
    betLedger(bets),
    ``,
    `Recent team room:`,
    roomTranscript(room, nameOf),
    ``,
    `Recently shipped:`,
    shipped,
    ``,
    `Real numbers (what the founder sees; grow these):`,
    realNumbers(company, products, employee.lastRunMetrics),
    ``,
    `Recent failures to consider fixing or unblocking:`,
    failures,
    ``,
    coordinate,
    `Make it real: products should end up runnable, and when ready, published (ask the founder via ask_boss before anything outward-facing like deploying or posting).`,
    `When you finish, post a one-line update to the team room with message_team(text).`,
    `End with a short summary of exactly what you shipped and where it lives (files, URLs).`,
  ].join("\n");
  return { description, title };
};

export const runPreamble = (product: Product | null, company: Company): string => {
  if (!product) {
    return `COMPANY-LEVEL WORK (not for one product). Working directory: ${company.workspaceDir}.`;
  }
  return `PRODUCT: ${product.name} — ${product.description}\nWorking directory: ${product.workspaceDir}\nThe company workspace, shared across products, is at ${company.workspaceDir}.`;
};

export const routineBrief = (r: Routine): TaskBrief => ({
  description: `${r.instruction}\n\n(Recurring company routine — runs every ${r.intervalHours}h.)`,
  title: r.name,
});

export const founderPing = (text: string): TaskBrief => ({
  description: [
    "The founder pinged you in the team room:",
    `"${text}"`,
    "",
    "Read the room with read_team_chat for context, do what they're asking (or answer their question), and reply with message_team.",
  ].join("\n"),
  title: `Founder: ${text.slice(0, 48)}`,
});

export const continuationBrief = (task: Task, ask: BlockedAsk, answer: string): TaskBrief => ({
  description: `You previously asked the founder:\n> ${serializeBlockedAsk(ask)}\n\nThe founder answered:\n> ${answer}\n\nContinue the work with that answer. Original task: ${task.title}`,
  title: `Continue: ${task.title.slice(0, 60)}`,
});

export const integrationConnectedAnswer = (kind: IntegrationKind): string =>
  `${INTEGRATION_LABELS[kind]} is now connected — the credentials are in your environment. Continue where you left off.`;

export const approvalAnswer = (approved: boolean, command: string): string =>
  approved
    ? `Approved. The sign-off is for exactly this, character for character, in this task only — a reworded command is a different command and will be held again:\n\n\`\`\`\n${command}\n\`\`\`\n\nIt covers one run of it (or, for a site or a connected tool, the rest of this run). Anything else outward-facing needs a fresh approval.`
    : "Not approved. Do not run it, and do not look for another way to achieve the same effect. Continue with the rest of the work.";
