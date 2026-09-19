import { isClosed } from "@/shared/bets";
import type { Bet } from "@/shared/bets";
import { INTEGRATION_LABELS, businessTypeById, serializeBlockedAsk } from "@/shared/domain";
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
  const critical = company.spentUsd >= company.budget.capUsd * 0.8;
  return `AI budget: ${formatUsd(company.spentUsd)} of ${formatUsd(company.budget.capUsd)} spent${critical ? " — over 80%: critical work only, keep runs short" : ""}.`;
};

/** What the allocator decided this run is for. */
export type Assignment =
  | { kind: "bet"; bet: Bet }
  /** Nothing is fundable, so the lead opens the next bet: on `product`, or on new ground when `widen`. */
  | { kind: "propose"; product: Product | null; widen: boolean };

const betMoney = (bet: Bet): string => `${formatUsd(bet.spentUsd)} of ${formatUsd(bet.budgetUsd)}`;

const betGoal = (bet: Bet): string =>
  bet.metric === "revenue" ? `+${formatUsd(bet.target)} revenue` : `+${bet.target} users`;

const betLine = (bet: Bet): string => {
  const st = bet.state;
  const head = `- ${bet.title} (${bet.id}) on ${bet.productId}: ${betGoal(bet)}, ${betMoney(bet)} spent`;
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

/** How many verdicts a brief lists. Facts only: what was bet, what it cost, what the number did. */
const VERDICTS_SHOWN = 6;

/** The ledger as the team reads it, in the brief and from read_bets. */
export const betLedger = (bets: readonly Bet[]): string => {
  const live = bets.filter((b) => !isClosed(b));
  const verdicts = bets
    .filter(isClosed)
    .toSorted((a, b) => b.state.closedAt - a.state.closedAt)
    .slice(0, VERDICTS_SHOWN);
  return [...live, ...verdicts].map(betLine).join("\n") || "(no bets yet)";
};

const assignmentLines = (assignment: Assignment, isLeader: boolean): string[] => {
  if (assignment.kind === "bet") {
    const { bet } = assignment;
    return [
      `THIS RUN SPENDS AGAINST A BET: "${bet.title}" (${bet.id}).`,
      `Hypothesis: ${bet.hypothesis}`,
      `It wins only if ${bet.productId}'s real ${bet.metric} move by ${betGoal(bet)} — the app judges that from the live number, not from what anyone reports. ${betMoney(bet)} of its budget is spent; when the budget runs out the work stops and the number gets ${bet.windowHours}h to answer.`,
      `Do the one thing most likely to move that number. Shipping is not the goal; the number is.`,
      isLeader
        ? `When the work that could move it is out the door, call measure_bet so the spending stops and the clock starts. If the bet is plainly dead, kill_bet and say why.`
        : `If you believe the work that could move it is already out the door, tell the lead in the team room.`,
    ];
  }
  const where = assignment.product
    ? `${assignment.product.name} (${assignment.product.id}) has room for one`
    : "every product already has its numbers bet on";
  return [
    `NOTHING IS FUNDED RIGHT NOW: the team only spends against bets, and no open bet has budget left. Opening the next one is your job this run.`,
    assignment.widen
      ? `Go somewhere new: a product the company does not have yet (create_product, then bet on it) or a channel it has never tried — ${where}.`
      : `${where}.`,
    `Call open_bet with a falsifiable hypothesis, the metric it should move ("users" or "revenue"), by how much, a budget cap in USD small enough to lose, and how many hours the number gets to answer. Then delegate the first pieces of work to it with "bet":"<slug>".`,
    `A product whose bets keep dying is a candidate for kill_product: its package is archived, its budget goes to the others.`,
  ];
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
  const focus =
    assignment.kind === "bet"
      ? (products.find((p) => p.id === assignment.bet.productId) ?? null)
      : assignment.product;
  const portfolio = products
    .map((p) => `- ${p.name} (${p.id}): ${p.description}${p === focus ? " ← this run" : ""}`)
    .join("\n");
  const isLeader = company.leaderId === employee.id;
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
    ...assignmentLines(assignment, isLeader),
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
  const title =
    assignment.kind === "bet"
      ? `Bet: ${assignment.bet.title}`
      : `Open the next bet for ${focus?.name ?? company.name}`;
  return { description, title };
};

export const runPreamble = (product: Product | null, company: Company): string => {
  if (!product) {
    return `COMPANY-LEVEL WORK (not for one product). Working directory: ${company.workspaceDir}.`;
  }
  const shared =
    product.workspaceDir === company.workspaceDir
      ? ""
      : `\nThe company workspace, shared across products, is at ${company.workspaceDir}.`;
  return `PRODUCT: ${product.name} — ${product.description}\nWorking directory: ${product.workspaceDir}${shared}`;
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

export const approvalAnswer = (approved: boolean): string =>
  approved
    ? "Approved — run it once. The sign-off covers this one command this one time, so running it again, or anything else outward-facing, needs a fresh approval."
    : "Not approved. Do not run it, and do not look for another way to achieve the same effect. Continue with the rest of the work.";

export const answeredSummary = (answer: string): string => `Founder answered: ${answer}`;
