import { useEffect, useMemo, useRef, useState } from "react";
import {
  useStore,
  getPortrait,
  assignWork,
  setModalOpen,
  listTasksFor,
} from "@/renderer/state/store";
import { RichText } from "@/renderer/ui/linkify";
import type { ActivityEvent, Employee, Task } from "@/shared/domain";

const COLS = 1;

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

export function Dialogue() {
  const { game, employees, activity, company } = useStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const [portrait, setPortrait] = useState<string | null>(null);
  const [mode, setMode] = useState<"menu" | "talk">("menu");
  const [sel, setSel] = useState(0);
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [answer, setAnswer] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const emp = useMemo(() => employees.find((e) => e.id === openId) ?? null, [employees, openId]);
  const blocked = useMemo(
    () => tasks.find((t) => t.status === "blocked" && t.blockedQuestion) ?? null,
    [tasks],
  );
  const options = useMemo(() => (emp ? buildOptions(emp, tasks) : []), [emp, tasks]);
  const talkIndex = options.length; // trailing "Talk…" command

  useEffect(() => {
    if (!game) return;
    const onInteract = (p: { employeeId: string }) => {
      setOpenId(p.employeeId);
      setMode("menu");
      setSel(0);
      setNote(null);
    };
    game.events.on("npc-interact", onInteract);
    return () => {
      game.events.off("npc-interact", onInteract);
    };
  }, [game]);

  useEffect(() => {
    setModalOpen(openId !== null);
  }, [openId]);

  useEffect(() => {
    setTasks([]);
    setAnswer("");
    if (!emp) {
      setPortrait(null);
      return;
    }
    let alive = true;
    void (async () => {
      const [url, t] = await Promise.all([getPortrait(emp.spriteSeed), listTasksFor(emp.id)]);
      if (alive) {
        setPortrait(url);
        setTasks(t);
      }
    })();
    return () => {
      alive = false;
    };
  }, [emp, activity.length]);

  const close = () => {
    setOpenId(null);
    setInput("");
    setMode("menu");
  };

  const send = async (title: string, instruction: string) => {
    if (!emp) return;
    setNote(`Sent to ${emp.name} ✓`);
    await assignWork(emp.id, title, instruction);
    window.setTimeout(() => setNote(null), 1800);
  };

  const sendAnswer = async () => {
    const text = answer.trim();
    const bridge = window.appBridge;
    if (!text || !blocked || !bridge) return;
    setNote("Answer sent ✓");
    setTasks((t) => t.filter((x) => x.id !== blocked.id));
    setAnswer("");
    await bridge.answerQuestion({ taskId: blocked.id, answer: text });
    window.setTimeout(() => setNote(null), 1800);
  };

  const choose = (i: number) => {
    if (i === talkIndex) {
      setMode("talk");
      window.setTimeout(() => inputRef.current?.focus(), 30);
      return;
    }
    const q = options[i];
    if (q) void send(q.label, q.instr);
  };

  const submitTalk = () => {
    const text = input.trim();
    if (!text) return;
    const title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    void send(title, text);
    setInput("");
    setMode("menu");
  };

  // keyboard: arrows navigate the menu grid; Enter selects; Esc backs out / closes
  useEffect(() => {
    if (!emp) return;
    const onKey = (e: KeyboardEvent) => {
      if (mode === "talk") {
        if (e.key === "Escape") {
          e.preventDefault();
          setMode("menu");
        }
        return;
      }
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // typing an answer
      const n = options.length + 1;
      if (e.key === "ArrowRight") setSel((s) => Math.min(n - 1, s + 1));
      else if (e.key === "ArrowLeft") setSel((s) => Math.max(0, s - 1));
      else if (e.key === "ArrowDown") setSel((s) => Math.min(n - 1, s + COLS));
      else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - COLS));
      else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose(sel);
      } else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp, mode, sel, options]);

  if (!emp || !company) return null;
  const mine = activity.filter((a) => a.employeeId === emp.id);
  // what they SAY: the latest real utterance (chat/message/ship), Pokémon-style
  const spoken = mine.filter(
    (a) => (a.kind === "chat" || a.kind === "message" || a.kind === "ship") && a.message,
  );
  const latest = spoken[spoken.length - 1];
  // what they're DOING: everything else stays a compact activity trail
  const trail: ActivityEvent[] = mine.filter((a) => a !== latest).slice(-3);
  const working = emp.status === "working";
  const running = tasks.find((t) => t.status === "running" || t.status === "queued");
  const speech = latest?.message
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
        {/* left: portrait + identity + recent activity (their "speech") */}
        <div className="flex w-[58%] flex-col gap-2">
          <div className="flex items-center gap-3">
            {portrait ? (
              <img
                src={portrait}
                alt={emp.name}
                className="h-16 w-16 [image-rendering:pixelated]"
                style={{ border: "3px solid var(--ink)", background: "#cfd6ea", borderRadius: 4 }}
              />
            ) : (
              <div
                className="h-16 w-16"
                style={{ border: "3px solid var(--ink)", background: "#cfd6ea", borderRadius: 4 }}
              />
            )}
            <div className="flex-1">
              <div className="text-[16px] uppercase tracking-wide">{emp.name}</div>
              <div className="text-[12px] text-[var(--accent-lo)]">{emp.title || emp.role}</div>
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

          {blocked ? (
            <div className="px-inset flex-1 p-2.5" style={{ borderColor: "var(--warn)" }}>
              <div className="text-[12px] text-[var(--danger)]">❗ {emp.name} needs your call:</div>
              <div className="mt-1 text-[13px] leading-snug text-[var(--text)]">
                <RichText text={blocked.blockedQuestion ?? ""} companyId={company.id} />
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void sendAnswer();
                    }
                  }}
                  placeholder="Your answer…"
                  className="px-field min-w-0 flex-1"
                  autoFocus
                />
                <button
                  onClick={() => void sendAnswer()}
                  disabled={!answer.trim()}
                  className="px-btn-accent px-btn"
                >
                  Answer
                </button>
              </div>
            </div>
          ) : (
            <div className="px-inset px-scroll flex min-h-[72px] flex-1 flex-col overflow-y-auto p-2.5">
              <Speech
                key={`${emp.id}:${latest?.id ?? "flavor"}`}
                text={speech.slice(0, 280)}
                companyId={company.id}
              />
              {trail.length > 0 ? (
                <div className="mt-auto space-y-0.5 pt-2 text-[11px] leading-snug opacity-70">
                  {trail.map((a, i) => (
                    <FeedLine key={a.id ?? i} e={a} companyId={company.id} />
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* right: command menu (battle style) or free-text */}
        <div className="flex w-[42%] flex-col">
          <div className="px-inset flex flex-1 flex-col p-2">
            {mode === "menu" ? (
              <>
                <div className="mb-1 grid flex-1 grid-cols-1 content-start gap-y-0.5">
                  {options.map((q, i) => (
                    <button
                      key={q.label}
                      data-sel={sel === i}
                      onMouseEnter={() => setSel(i)}
                      onClick={() => choose(i)}
                      className="px-cmd truncate"
                    >
                      {q.label}
                    </button>
                  ))}
                  <button
                    data-sel={sel === talkIndex}
                    onMouseEnter={() => setSel(talkIndex)}
                    onClick={() => choose(talkIndex)}
                    className="px-cmd"
                  >
                    Talk…
                  </button>
                </div>
                <div className="text-right text-[10px] text-[var(--text-dim)]">
                  ↑↓ select · ⏎ · esc
                </div>
              </>
            ) : (
              <div className="flex h-full flex-col gap-2">
                <div className="text-[12px] text-[var(--text-dim)]">
                  Tell {emp.name} what to do:
                </div>
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
                  <button onClick={() => setMode("menu")} className="px-btn flex-1">
                    Back
                  </button>
                  <button
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
          {note ? (
            <div className="mt-1 text-center text-[12px] text-[var(--ok)]">{note}</div>
          ) : null}
        </div>

        <button
          onClick={close}
          title="Close (esc)"
          className="absolute top-0 right-0 p-2.5 text-[15px] leading-none text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** The employee's spoken line: a Pokémon-style typewriter reveal. Click to skip. */
function Speech({ text, companyId }: { text: string; companyId: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    setShown(0);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(text.length);
      return;
    }
    const id = window.setInterval(() => {
      setShown((n) => {
        if (n + 2 >= text.length) {
          window.clearInterval(id);
          return text.length;
        }
        return n + 2;
      });
    }, 16);
    return () => window.clearInterval(id);
  }, [text]);

  const done = shown >= text.length;
  return (
    <div
      onClick={() => setShown(text.length)}
      className="text-[14px] leading-relaxed break-words text-[var(--text)]"
      style={{ cursor: done ? "default" : "pointer" }}
    >
      {done ? <RichText text={text} companyId={companyId} /> : text.slice(0, shown)}
      {done ? null : <span className="px-live-dot">▌</span>}
    </div>
  );
}

function FeedLine({ e, companyId }: { e: ActivityEvent; companyId: string }) {
  const color =
    e.kind === "tool_call"
      ? "#2f6fb0"
      : e.kind === "message"
        ? "#2b2f46"
        : e.kind === "ship"
          ? "#2e8a4e"
          : e.kind === "chat"
            ? "#5a4fae"
            : "#6d7187";
  const prefix =
    e.kind === "tool_call"
      ? "⚙ "
      : e.kind === "message"
        ? "💬 "
        : e.kind === "ship"
          ? "📦 "
          : e.kind === "chat"
            ? "🗨 "
            : e.kind === "status"
              ? "› "
              : "· ";
  return (
    <div className="break-words" style={{ color }}>
      {prefix}
      <RichText text={(e.message ?? e.kind).slice(0, 300)} companyId={companyId} />
    </div>
  );
}
