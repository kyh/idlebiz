import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useStore, sendFounderChat, listTasksFor } from "@/renderer/state/store";
import { useTransientNote } from "@/renderer/hooks/use-transient-note";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { AnswerForm } from "@/renderer/ui/answer-form";
import { RichText } from "@/renderer/ui/linkify";
import { useModal } from "@/renderer/ui/modal";
import { Portrait } from "@/renderer/ui/portrait";
import type { ActivityEvent, ActivityKind } from "@/shared/activity";
import type { Employee, Task } from "@/shared/domain";

const NOTE_MS = 1800;

interface ChatOption {
  label: string;
  instr: string;
}

const short = (s: string, n = 26): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A role-flavored action so every employee's menu feels like THEIR menu. */
function roleOption(emp: Employee): ChatOption {
  const r = `${emp.role} ${emp.title}`.toLowerCase();
  if (/(engineer|dev|program|code)/.test(r))
    return {
      label: "Fix something",
      instr: "Find the most broken or fragile thing in the product right now and fix it properly.",
    };
  if (/(design|art|pixel|ux|ui)/.test(r))
    return {
      label: "Polish the look",
      instr:
        "Do a visual polish pass on the product: pick the roughest-looking part and make it feel great.",
    };
  if (/(market|growth|community|social|brand)/.test(r))
    return {
      label: "Draft launch post",
      instr:
        "Draft a launch/update post for the product as it exists today. Punchy, honest, ready to publish.",
    };
  if (/(pm|product manager|producer|lead|ops)/.test(r))
    return {
      label: "Reprioritize",
      instr:
        "Review the current state of the business and team output; write a short prioritized plan for what the team should do next, then delegate the top item.",
    };
  if (/(audio|sound|music)/.test(r))
    return {
      label: "Improve audio",
      instr: "Improve the product's sound: pick the most impactful audio gap and address it.",
    };
  if (/(write|edit|research|content|doc)/.test(r))
    return {
      label: "Write next piece",
      instr: "Write the next most valuable piece of content for the business, ready to publish.",
    };
  return {
    label: "Improve product",
    instr: "Pick the most valuable improvement to the product you can finish now and do it.",
  };
}

/** Options shaped by what this employee is actually doing right now. */
function buildOptions(emp: Employee, tasks: Task[]): ChatOption[] {
  const out: ChatOption[] = [];
  const running = tasks.find((t) => t.status === "running" || t.status === "queued");
  const lastDone = tasks.find((t) => t.status === "done" && t.summary);
  if (running) {
    out.push({
      label: `Check in: ${short(running.title, 18)}`,
      instr: `Give a quick status update on "${running.title}": what's done, what's left, anything at risk. Keep it brief, then continue.`,
    });
  }
  if (lastDone) {
    out.push({
      label: `Build on: ${short(lastDone.title, 18)}`,
      instr: `Take the next step on what you last shipped ("${lastDone.title}"). Build on it: extend it, polish it, or fix its weakest part.\n\nYour summary of that work was:\n${(lastDone.summary ?? "").slice(0, 500)}`,
    });
  }
  out.push(roleOption(emp));
  if (out.length < 4)
    out.push({
      label: "Daily standup",
      instr:
        "Give a brief standup: what you did recently, what you're doing next, and any blockers.",
    });
  if (out.length < 4)
    out.push({
      label: "Set direction",
      instr:
        "Step back and decide the most valuable thing to build next for the company, then start it.",
    });
  return out.slice(0, 4);
}

/** Walk up to someone and press E: the battle-box conversation with that employee. */
export function Dialogue() {
  const game = useStore((s) => s.game);
  const employees = useStore((s) => s.employees);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!game) return;
    const onInteract = (p: { employeeId: string }) => setOpenId(p.employeeId);
    game.events.on("npc-interact", onInteract);
    return () => {
      game.events.off("npc-interact", onInteract);
    };
  }, [game]);

  const emp = employees.find((e) => e.id === openId);
  if (!emp) return null;
  return <DialoguePanel key={emp.id} emp={emp} onClose={() => setOpenId(null)} />;
}

/** What they SAY, as opposed to what they do: chat, a message, a ship. */
const isSpoken = (
  a: ActivityEvent,
): a is Extract<ActivityEvent, { kind: "chat" | "message" | "ship" }> =>
  a.kind === "chat" || a.kind === "message" || a.kind === "ship";

function DialoguePanel({ emp, onClose }: { emp: Employee; onClose: () => void }) {
  useModal();
  const company = useStore((s) => s.company);
  const activity = useStore((s) => s.activity);
  const [mode, setMode] = useState<"menu" | "talk">("menu");
  const [sel, setSel] = useState(0);
  const [input, setInput] = useState("");
  const [note, showNote] = useTransientNote(NOTE_MS);
  const [fetched, setFetched] = useState<{ asOf: number | null; list: Task[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const mine = useMemo(() => activity.filter((a) => a.employeeId === emp.id), [activity, emp.id]);
  // Only a status event moves a task, so its id is what a task list is current
  // "as of" — and what makes a refetch worth making. Not the feed length: the
  // feed is a 300-event ring, and a length-keyed refetch stops once it fills.
  const lastStatusId = mine.findLast((a) => a.kind === "status")?.id ?? null;
  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listTasksFor(emp.id);
      if (alive) setFetched({ asOf: lastStatusId, list });
    })();
    return () => {
      alive = false;
    };
  }, [emp.id, lastStatusId]);
  const tasks = fetched?.list ?? [];

  // only free-text questions get the inline answer form; integration asks
  // live in the inbox where the [Connect] button is. Shown only for a current
  // list: the moment an answer lands, the status event makes this one stale,
  // and a form for a question already answered would send twice.
  const blocked =
    fetched?.asOf === lastStatusId
      ? tasks.find((t) => t.status === "blocked" && t.blocked?.type === "question")
      : undefined;
  const options = buildOptions(emp, tasks);
  const talkIndex = options.length; // trailing "Talk…" command

  // everything the founder says goes through the team channel; the @slug
  // mention wakes exactly this employee with the message as their brief
  const send = (instruction: string) => {
    showNote(`Sent to ${emp.name} ✓`);
    void sendFounderChat(`@${emp.id} ${instruction}`);
  };

  const choose = (i: number) => {
    if (i === talkIndex) {
      setMode("talk");
      window.setTimeout(() => inputRef.current?.focus(), 30);
      return;
    }
    const q = options[i];
    if (q) send(q.instr);
  };

  const submitTalk = () => {
    const text = input.trim();
    if (!text) return;
    send(text);
    setInput("");
    setMode("menu");
  };

  // keyboard: arrows walk the menu; Enter selects; Esc backs out / closes
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (mode === "talk") {
      if (e.key === "Escape") {
        e.preventDefault();
        setMode("menu");
      }
      return;
    }
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return; // typing an answer
    const last = options.length; // the Talk… row
    if (e.key === "ArrowDown") setSel((s) => Math.min(last, s + 1));
    else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
    else if (e.key === "Enter" || e.key === " ") choose(sel);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!company) return null;
  // what they SAY: the latest real utterance (chat/message/ship), Pokémon-style
  const spoken = mine.filter(isSpoken).filter((a) => a.message);
  const latest = spoken[spoken.length - 1];
  // what they're DOING: everything else stays a compact activity trail
  const trail: ActivityEvent[] = mine.filter((a) => a !== latest).slice(-3);
  const working = emp.status === "working";
  const running = tasks.find((t) => t.status === "running" || t.status === "queued");
  const speech = latest
    ? latest.kind === "ship"
      ? `Shipped it! ${latest.message}`
      : latest.message
    : working
      ? running
        ? `On it — "${running.title}".`
        : "Heads down on something right now."
      : "All quiet. What should I do next?";

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex justify-center p-4">
      <div className="px-battle flex w-full max-w-3xl gap-3 p-3">
        <div className="flex w-[58%] flex-col gap-2">
          <Identity emp={emp} working={working} />
          {blocked ? (
            <div className="px-inset flex-1 p-2.5" style={{ borderColor: "var(--warn)" }}>
              <div className="text-xs text-danger">❗ {emp.name} needs your call:</div>
              <div className="mt-1 text-sm leading-snug text-text">
                <RichText
                  text={blocked.blocked?.type === "question" ? blocked.blocked.question : ""}
                  companyId={company.id}
                />
              </div>
              <AnswerForm task={blocked} autoFocus onSent={() => showNote("Answer sent ✓")} />
            </div>
          ) : (
            <div className="px-inset px-scroll flex min-h-[72px] flex-1 flex-col overflow-y-auto p-2.5">
              <Speech
                key={latest?.id ?? "flavor"}
                text={speech.slice(0, 280)}
                companyId={company.id}
              />
              {trail.length > 0 ? (
                <div className="mt-auto space-y-0.5 pt-2 text-xs leading-snug opacity-70">
                  {trail.map((a) => (
                    <FeedLine key={a.id} e={a} companyId={company.id} />
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex w-[42%] flex-col">
          <div className="px-inset flex flex-1 flex-col p-2">
            {mode === "menu" ? (
              <CommandMenu options={options} sel={sel} onHover={setSel} onChoose={choose} />
            ) : (
              <div className="flex h-full flex-col gap-2">
                <div className="text-xs text-text-dim">Tell {emp.name} what to do:</div>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitTalk();
                    }
                  }}
                  placeholder="e.g. build a settings page"
                  className="px-field w-full"
                />
                <div className="mt-auto flex gap-2">
                  <button type="button" onClick={() => setMode("menu")} className="px-btn flex-1">
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => submitTalk()}
                    disabled={!input.trim()}
                    className="px-btn-accent px-btn flex-1"
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
          {note ? <div className="mt-1 text-center text-xs text-ok">{note}</div> : null}
        </div>

        <button
          type="button"
          onClick={onClose}
          title="Close (esc)"
          className="absolute top-0 right-0 p-2.5 text-sm leading-none text-text-dim hover:text-text"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** Portrait, name, title and the working/idle badge. */
function Identity({ emp, working }: { emp: Employee; working: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Portrait seed={emp.spriteSeed} size="md" alt={emp.name} />
      <div className="flex-1">
        <div className="text-base uppercase tracking-wide">{emp.name}</div>
        <div className="text-xs text-accent-lo">{emp.title || emp.role}</div>
        <span
          className="px-badge mt-1 inline-block"
          style={
            working
              ? { background: "var(--warn)", color: "#3a2c0a" }
              : { background: "#d8d4c4", color: "var(--text)" }
          }
        >
          {working ? <span className="px-live-dot">● working</span> : "idle"}
        </span>
      </div>
    </div>
  );
}

/** The battle-style command list: the role options, then Talk… for free text. */
function CommandMenu({
  options,
  sel,
  onHover,
  onChoose,
}: {
  options: ChatOption[];
  sel: number;
  onHover: (i: number) => void;
  onChoose: (i: number) => void;
}) {
  const talkIndex = options.length;
  return (
    <>
      <div className="mb-1 flex flex-1 flex-col content-start gap-y-0.5">
        {options.map((q, i) => (
          <button
            type="button"
            key={q.label}
            data-sel={sel === i}
            onMouseEnter={() => onHover(i)}
            onClick={() => onChoose(i)}
            className="px-cmd truncate"
          >
            {q.label}
          </button>
        ))}
        <button
          type="button"
          data-sel={sel === talkIndex}
          onMouseEnter={() => onHover(talkIndex)}
          onClick={() => onChoose(talkIndex)}
          className="px-cmd"
        >
          Talk…
        </button>
      </div>
      <div className="text-right text-xs text-text-dim">↑↓ move · ⏎ select · esc close</div>
    </>
  );
}

/** The employee's spoken line: a Pokémon-style typewriter reveal. Click to skip. */
function Speech({ text, companyId }: { text: string; companyId: string }) {
  const { shown, done, skip } = useTypewriter(text);
  return (
    <div
      onClick={done ? undefined : skip}
      onKeyDown={
        done
          ? undefined
          : (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              skip();
            }
      }
      role={done ? undefined : "button"}
      tabIndex={done ? undefined : 0}
      className="text-sm leading-relaxed break-words text-text"
      style={{ cursor: done ? "default" : "pointer" }}
    >
      {done ? <RichText text={text} companyId={companyId} /> : shown}
      {done ? null : <span className="px-live-dot">▌</span>}
    </div>
  );
}

interface LineStyle {
  color: string;
  prefix: string;
}
/** How each kind of line reads in the trail; anything else is a quiet dot. */
const LINE_STYLES = new Map<ActivityKind, LineStyle>([
  ["tool_call", { color: "#2f6fb0", prefix: "⚙ " }],
  ["message", { color: "#2b2f46", prefix: "💬 " }],
  ["ship", { color: "#2e8a4e", prefix: "📦 " }],
  ["chat", { color: "#5a4fae", prefix: "🗨 " }],
  ["status", { color: "#6d7187", prefix: "› " }],
]);
const QUIET_LINE: LineStyle = { color: "#6d7187", prefix: "· " };

function FeedLine({ e, companyId }: { e: ActivityEvent; companyId: string }) {
  const { color, prefix } = LINE_STYLES.get(e.kind) ?? QUIET_LINE;
  const text = "message" in e ? e.message : e.kind;
  return (
    <div className="break-words" style={{ color }}>
      {prefix}
      <RichText text={text.slice(0, 300)} companyId={companyId} />
    </div>
  );
}
