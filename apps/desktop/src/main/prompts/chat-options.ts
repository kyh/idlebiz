import type { Employee, Task } from "@/shared/domain";
import { taskIn } from "@/shared/domain";
import type { ChatOption } from "@/shared/ipc-registry";

const short = (s: string, n = 18): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function roleOption(emp: Employee): ChatOption {
  const r = `${emp.role} ${emp.title}`.toLowerCase();
  if (/(engineer|dev|program|code)/.test(r))
    return {
      label: "Fix something",
      instruction:
        "Find the most broken or fragile thing in the product right now and fix it properly.",
    };
  if (/(design|art|pixel|ux|ui)/.test(r))
    return {
      label: "Polish the look",
      instruction:
        "Do a visual polish pass on the product: pick the roughest-looking part and make it feel great.",
    };
  if (/(market|growth|community|social|brand)/.test(r))
    return {
      label: "Draft launch post",
      instruction:
        "Draft a launch/update post for the product as it exists today. Punchy, honest, ready to publish.",
    };
  if (/(pm|product manager|producer|lead|ops)/.test(r))
    return {
      label: "Reprioritize",
      instruction:
        "Review the current state of the business and team output; write a short prioritized plan for what the team should do next, then delegate the top item.",
    };
  if (/(audio|sound|music)/.test(r))
    return {
      label: "Improve audio",
      instruction: "Improve the product's sound: pick the most impactful audio gap and address it.",
    };
  if (/(write|edit|research|content|doc)/.test(r))
    return {
      label: "Write next piece",
      instruction:
        "Write the next most valuable piece of content for the business, ready to publish.",
    };
  return {
    label: "Improve product",
    instruction: "Pick the most valuable improvement to the product you can finish now and do it.",
  };
}

const FILLERS: readonly ChatOption[] = [
  {
    label: "Daily standup",
    instruction:
      "Give a brief standup: what you did recently, what you're doing next, and any blockers.",
  },
  {
    label: "Set direction",
    instruction:
      "Step back and decide the most valuable thing to build next for the company, then start it.",
  },
];

const MENU_SIZE = 4;

export function chatOptions(
  emp: Employee,
  open: readonly Task[],
  shipped: readonly Task[],
): ChatOption[] {
  const out: ChatOption[] = [];
  const running = open.find((t) => t.state.kind === "running" || t.state.kind === "queued");
  const lastDone = shipped.filter(taskIn("done")).find((t) => t.state.summary);
  if (running) {
    out.push({
      label: `Check in: ${short(running.title)}`,
      instruction: `Give a quick status update on "${running.title}": what's done, what's left, anything at risk. Keep it brief, then continue.`,
    });
  }
  if (lastDone) {
    out.push({
      label: `Build on: ${short(lastDone.title)}`,
      instruction: `Take the next step on what you last shipped ("${lastDone.title}"). Build on it: extend it, polish it, or fix its weakest part.\n\nYour summary of that work was:\n${(lastDone.state.summary ?? "").slice(0, 500)}`,
    });
  }
  out.push(roleOption(emp));
  for (const filler of FILLERS) if (out.length < MENU_SIZE) out.push(filler);
  return out;
}
