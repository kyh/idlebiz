import { INTEGRATION_LABELS, businessTypeById } from "@/shared/domain";
import type {
  BlockedAsk,
  Company,
  Employee,
  IntegrationKind,
  Routine,
  Task,
  Team,
  TeamMessage,
} from "@/shared/domain";
import { serializeBlockedAsk } from "@/shared/domain";
import { formatUsd } from "@/shared/format";

// Everything the scheduler says to an employee when it hands them work. Pure
// functions of domain values: the scheduler gathers, these phrase.

/** What a task asks for: a title the office shows, and the prose the agent reads. */
export interface TaskBrief {
  title: string;
  description: string;
}

/** A room line as an agent reads it back. */
const roomLine = (m: TeamMessage, nameOf: (id: string) => string): string =>
  `- ${m.fromEmployeeId ? nameOf(m.fromEmployeeId) : "founder"}: ${m.text}`;

/** The team room, newest last, or a note that it is empty. */
export const roomTranscript = (
  messages: readonly TeamMessage[],
  nameOf: (id: string) => string,
): string => messages.map((m) => roomLine(m, nameOf)).join("\n") || "(no messages yet)";

/** How much has been spent, and whether that should change how the employee works. */
function budgetLine(company: Company): string {
  if (company.budget.mode !== "capped") {
    return `AI spend so far: ${formatUsd(company.spentUsd)} (no cap set).`;
  }
  const critical = company.spentUsd >= company.budget.capUsd * 0.8;
  return `AI budget: ${formatUsd(company.spentUsd)} of ${formatUsd(company.budget.capUsd)} spent${critical ? " — over 80%: critical work only, keep runs short" : ""}.`;
}

export interface AutonomousBriefInput {
  company: Company;
  employee: Employee;
  /** Everyone at the company; the roster shown is the employee's team when they have one. */
  employees: readonly Employee[];
  team: Team | null;
  room: readonly TeamMessage[];
  /** Summaries of recent ships, newest last. */
  ships: readonly string[];
  /** Dead-lettered tasks worth a second look. */
  problems: readonly Task[];
  nameOf: (id: string) => string;
}

/**
 * The per-employee heartbeat: prompt for their next autonomous move, grounded
 * in the team room, recent ships, and recent failures. The team leader is asked
 * to coordinate (chain / fan out) while members execute and report back.
 */
export function autonomousBrief(input: AutonomousBriefInput): TaskBrief {
  const { company, employee, employees, team, room, ships, problems, nameOf } = input;
  const isLeader = team?.leaderId === employee.id;
  const teammates = team ? employees.filter((e) => e.teamId === team.id) : employees;
  const roster =
    teammates
      .map((e) => `${e.name} (${e.title})${team?.leaderId === e.id ? " — lead" : ""}`)
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
    ? `You LEAD ${team?.name ?? "this team"}. Your job is to coordinate: decide the most valuable next outcome, then either do one focused chunk yourself or break it up and hand pieces to teammates — use the delegate tool once for a single handoff, or several times to fan work out in parallel. Keep everyone moving and unblocked.
You also OWN headcount (hard cap ${company.maxAgents} seats, ${employees.length} filled): hire when the backlog demands a role you don't have (hire tool — give role, title, name, persona), release teammates whose role stopped pulling weight (release tool — their work is archived, not lost). Size the team to the budget: more people burn money faster. ${budget}`
    : `You're on ${team?.name ?? "the team"}${team?.leaderId ? `, led by ${nameOf(team.leaderId)}` : ""}. Check the team room first with read_team_chat, pick up what your role should own, and execute it. If something is better owned by another role, hand it off with the delegate tool. ${budget}`;

  const description = [
    `You are operating autonomously to grow ${company.name}.`,
    `Mission: ${company.mission}`,
    `Business type: ${businessTypeById(company.businessType).label}.`,
    `Your role: ${employee.title}.`,
    `Your team: ${roster}.`,
    ``,
    `Recent team room:`,
    roomTranscript(room, nameOf),
    ``,
    `Recently shipped:`,
    shipped,
    ``,
    `Recent failures to consider fixing or unblocking:`,
    failures,
    ``,
    coordinate,
    `Make it real: products should end up runnable, and when ready, published (ask the founder via ask_boss before anything outward-facing like deploying or posting).`,
    `When you finish, post a one-line update to the team room with message_team(text).`,
    `End with a short summary of exactly what you shipped and where it lives (files, URLs).`,
  ].join("\n");
  return { title: `Advance ${company.name}`, description };
}

/** A recurring directive, fired on its cadence. */
export const routineBrief = (r: Routine): TaskBrief => ({
  title: r.name,
  description: `${r.instruction}\n\n(Recurring company routine — runs every ${r.intervalHours}h.)`,
});

/** The founder @-mentioned them in the room. */
export const founderPing = (text: string): TaskBrief => ({
  title: `Founder: ${text.slice(0, 48)}`,
  description: [
    "The founder pinged you in the team room:",
    `"${text}"`,
    "",
    "Read the room with read_team_chat for context, do what they're asking (or answer their question), and reply with message_team.",
  ].join("\n"),
});

/** The task they were blocked on can continue: here is what the founder said. */
export const continuationBrief = (task: Task, ask: BlockedAsk, answer: string): TaskBrief => ({
  title: `Continue: ${task.title.slice(0, 60)}`,
  description: `You previously asked the founder:\n> ${serializeBlockedAsk(ask)}\n\nThe founder answered:\n> ${answer}\n\nContinue the work with that answer. Original task: ${task.title}`,
});

/** What the founder "said" when they connected the integration a task was waiting on. */
export const integrationConnectedAnswer = (kind: IntegrationKind): string =>
  `${INTEGRATION_LABELS[kind]} is now connected — the credentials are in your environment. Continue where you left off.`;

/** What the founder "said" by deciding on a held command. */
export const approvalAnswer = (approved: boolean): string =>
  approved
    ? "Approved — run it once. The sign-off covers this one command this one time, so running it again, or anything else outward-facing, needs a fresh approval."
    : "Not approved. Do not run it, and do not look for another way to achieve the same effect. Continue with the rest of the work.";

/** What the founder's reply to a question looks like in the settled task. */
export const answeredSummary = (answer: string): string => `Founder answered: ${answer}`;
