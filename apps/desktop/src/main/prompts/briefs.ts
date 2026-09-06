import { INTEGRATION_LABELS, businessTypeById } from "@/shared/domain";
import type {
  BlockedAsk,
  Company,
  Employee,
  IntegrationKind,
  Product,
  Routine,
  Task,
  TeamMessage,
} from "@/shared/domain";
import { serializeBlockedAsk } from "@/shared/domain";
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
  products: readonly Product[];
  focus: Product | null;
  employees: readonly Employee[];
  room: readonly TeamMessage[];
  /** Summaries of recent ships, newest last. */
  ships: readonly string[];
  /** Dead-lettered tasks worth a second look. */
  problems: readonly Task[];
  nameOf: (id: string) => string;
}

export function autonomousBrief(input: AutonomousBriefInput): TaskBrief {
  const { company, employee, employees, products, focus, room, ships, problems, nameOf } = input;
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
  return { title: `Advance ${focus?.name ?? company.name}`, description };
}

export function runPreamble(product: Product | null, company: Company): string {
  if (!product) {
    return `COMPANY-LEVEL WORK (not for one product). Working directory: ${company.workspaceDir}.`;
  }
  const shared =
    product.workspaceDir === company.workspaceDir
      ? ""
      : `\nThe company workspace, shared across products, is at ${company.workspaceDir}.`;
  return `PRODUCT: ${product.name} — ${product.description}\nWorking directory: ${product.workspaceDir}${shared}`;
}

export const routineBrief = (r: Routine): TaskBrief => ({
  title: r.name,
  description: `${r.instruction}\n\n(Recurring company routine — runs every ${r.intervalHours}h.)`,
});

export const founderPing = (text: string): TaskBrief => ({
  title: `Founder: ${text.slice(0, 48)}`,
  description: [
    "The founder pinged you in the team room:",
    `"${text}"`,
    "",
    "Read the room with read_team_chat for context, do what they're asking (or answer their question), and reply with message_team.",
  ].join("\n"),
});

export const continuationBrief = (task: Task, ask: BlockedAsk, answer: string): TaskBrief => ({
  title: `Continue: ${task.title.slice(0, 60)}`,
  description: `You previously asked the founder:\n> ${serializeBlockedAsk(ask)}\n\nThe founder answered:\n> ${answer}\n\nContinue the work with that answer. Original task: ${task.title}`,
});

export const integrationConnectedAnswer = (kind: IntegrationKind): string =>
  `${INTEGRATION_LABELS[kind]} is now connected — the credentials are in your environment. Continue where you left off.`;

export const approvalAnswer = (approved: boolean): string =>
  approved
    ? "Approved — run it once. The sign-off covers this one command this one time, so running it again, or anything else outward-facing, needs a fresh approval."
    : "Not approved. Do not run it, and do not look for another way to achieve the same effect. Continue with the rest of the work.";

export const answeredSummary = (answer: string): string => `Founder answered: ${answer}`;
