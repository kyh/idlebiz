import type { ChatOption, Employee, Task } from "@/shared/domain";

const short = (s: string, n = 18): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const roleOption = (emp: Employee): ChatOption => {
  const r = `${emp.role} ${emp.title}`.toLowerCase();
  if (/(?:engineer|dev|program|code)/u.test(r)) {
    return {
      instruction:
        "Find the most broken or fragile thing in the product right now and fix it properly.",
      label: "Fix something",
    };
  }
  if (/(?:design|art|pixel|ux|ui)/u.test(r)) {
    return {
      instruction:
        "Do a visual polish pass on the product: pick the roughest-looking part and make it feel great.",
      label: "Polish the look",
    };
  }
  if (/(?:market|growth|community|social|brand)/u.test(r)) {
    return {
      instruction:
        "Draft a launch/update post for the product as it exists today. Punchy, honest, ready to publish.",
      label: "Draft launch post",
    };
  }
  if (/(?:pm|product manager|producer|lead|ops)/u.test(r)) {
    return {
      instruction:
        "Review the current state of the business and team output; write a short prioritized plan for what the team should do next, then delegate the top item.",
      label: "Reprioritize",
    };
  }
  if (/(?:audio|sound|music)/u.test(r)) {
    return {
      instruction: "Improve the product's sound: pick the most impactful audio gap and address it.",
      label: "Improve audio",
    };
  }
  if (/(?:write|edit|research|content|doc)/u.test(r)) {
    return {
      instruction:
        "Write the next most valuable piece of content for the business, ready to publish.",
      label: "Write next piece",
    };
  }
  return {
    instruction: "Pick the most valuable improvement to the product you can finish now and do it.",
    label: "Improve product",
  };
};

const FILLERS: readonly ChatOption[] = [
  {
    instruction:
      "Give a brief standup: what you did recently, what you're doing next, and any blockers.",
    label: "Daily standup",
  },
  {
    instruction:
      "Step back and decide the most valuable thing to build next for the company, then start it.",
    label: "Set direction",
  },
];

const MENU_SIZE = 4;

export const chatOptions = (emp: Employee, open: readonly Task[]): ChatOption[] => {
  const out: ChatOption[] = [];
  const running = open.find((t) => t.state.kind === "running" || t.state.kind === "queued");
  const { lastShip } = emp;
  if (running) {
    out.push({
      instruction: `Give a quick status update on "${running.title}": what's done, what's left, anything at risk. Keep it brief, then continue.`,
      label: `Check in: ${short(running.title)}`,
    });
  }
  if (lastShip) {
    out.push({
      instruction: `Take the next step on what you last shipped ("${lastShip.title}"). Build on it: extend it, polish it, or fix its weakest part.\n\nYour summary of that work was:\n${lastShip.summary}`,
      label: `Build on: ${short(lastShip.title)}`,
    });
  }
  out.push(roleOption(emp));
  for (const filler of FILLERS) {
    if (out.length < MENU_SIZE) {
      out.push(filler);
    }
  }
  return out;
};
