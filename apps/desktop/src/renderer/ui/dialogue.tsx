import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { bridge } from "@/renderer/bridge";
import { useStore, directEmployee, listTasksFor } from "@/renderer/state/store";
import { useAsync } from "@/renderer/hooks/use-async";
import { useTransientNote } from "@/renderer/hooks/use-transient-note";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { AnswerForm } from "@/renderer/ui/answer-form";
import { RichText } from "@/renderer/ui/linkify";
import { useModal } from "@/renderer/ui/modal";
import { Portrait } from "@/renderer/ui/portrait";
import type { ActivityEvent, ActivityKind } from "@/shared/activity";
import { taskIn } from "@/shared/domain";
import type { Employee } from "@/shared/domain";
import type { ChatOption } from "@/shared/ipc-registry";

const NOTE_MS = 1800;

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
  const inputRef = useRef<HTMLInputElement>(null);

  const mine = useMemo(() => activity.filter((a) => a.employeeId === emp.id), [activity, emp.id]);
  // Only a status event moves a task, so its id is what a task list is current
  // "as of" — and what makes a refetch worth making. Not the feed length: the
  // feed is a 300-event ring, and a length-keyed refetch stops once it fills.
  const lastStatusId = mine.findLast((a) => a.kind === "status")?.id ?? null;
  const fetched = useAsync(
    async () => ({
      asOf: lastStatusId,
      list: await listTasksFor(emp.id),
      options: await bridge().employeeOptions({ employeeId: emp.id }),
    }),
    [emp.id, lastStatusId],
  );
  const tasks = fetched?.list ?? [];

  // only free-text questions get the inline answer form; integration asks
  // live in the inbox where the [Connect] button is. Shown only for a current
  // list: the moment an answer lands, the status event makes this one stale,
  // and a form for a question already answered would send twice.
  const asked =
    fetched?.asOf === lastStatusId
      ? tasks.filter(taskIn("blocked")).find((t) => t.state.ask.type === "question")
      : undefined;
  const question = asked && asked.state.ask.type === "question" ? asked.state.ask.question : null;
  // the menu: main's options for this employee, then Talk… for free text
  const rows: Row[] = [
    ...(fetched?.options ?? []).map((option): Row => ({ kind: "ask", option })),
    { kind: "talk" },
  ];

  // everything the founder says goes through the team channel; the @slug
  // mention wakes exactly this employee with the message as their brief
  const send = (instruction: string) => {
    showNote(`Sent to ${emp.name} ✓`);
    void directEmployee(emp.id, instruction);
  };

  const choose = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === "talk") {
      setMode("talk");
      window.setTimeout(() => inputRef.current?.focus(), 30);
      return;
    }
    send(row.option.instruction);
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
    if (e.key === "ArrowDown") setSel((s) => Math.min(rows.length - 1, s + 1));
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
  const running = tasks.find((t) => t.state.kind === "running" || t.state.kind === "queued");
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
      <div className="px-battle px-pop flex w-full max-w-3xl gap-3 p-3">
        <div className="flex w-[58%] flex-col gap-2">
          <Identity emp={emp} working={working} />
          {asked && question !== null ? (
            <div className="px-inset flex-1 p-2.5" style={{ borderColor: "var(--warn)" }}>
              <div className="text-xs text-danger">❗ {emp.name} needs your call:</div>
              <div className="mt-1 text-sm leading-snug text-fg">
                <RichText text={question} companyId={company.id} />
              </div>
              <AnswerForm task={asked} autoFocus onSent={() => showNote("Answer sent ✓")} />
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
              <CommandMenu rows={rows} sel={sel} onHover={setSel} onChoose={choose} />
            ) : (
              <div className="flex h-full flex-col gap-2">
                <div className="text-xs text-fg-dim">Tell {emp.name} what to do:</div>
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
          className="absolute top-0 right-0 p-2.5 text-sm leading-none text-fg-dim hover:text-fg"
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
              : { background: "#d8d4c4", color: "var(--fg)" }
          }
        >
          {working ? <span className="px-live-dot">● working</span> : "idle"}
        </span>
      </div>
    </div>
  );
}

/** One line of the command menu: something to ask, or the way to say it yourself. */
type Row = { kind: "ask"; option: ChatOption } | { kind: "talk" };
const labelOf = (row: Row): string => (row.kind === "ask" ? row.option.label : "Talk…");

/** The battle-style command list, one row per line. */
function CommandMenu({
  rows,
  sel,
  onHover,
  onChoose,
}: {
  rows: readonly Row[];
  sel: number;
  onHover: (i: number) => void;
  onChoose: (i: number) => void;
}) {
  return (
    <>
      <div className="mb-1 flex flex-1 flex-col content-start gap-y-0.5">
        {rows.map((row, i) => (
          <button
            type="button"
            key={labelOf(row)}
            data-sel={sel === i}
            onMouseEnter={() => onHover(i)}
            onClick={() => onChoose(i)}
            className="px-cmd truncate"
          >
            {labelOf(row)}
          </button>
        ))}
      </div>
      <div className="text-right text-xs text-fg-dim">↑↓ move · ⏎ select · esc close</div>
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
      className="text-sm leading-relaxed break-words text-fg"
      style={{ cursor: done ? "default" : "pointer" }}
    >
      {done ? <RichText text={text} companyId={companyId} /> : shown}
      {done ? (
        <span className="px-more ml-1 text-accent-lo">▼</span>
      ) : (
        <span className="px-live-dot">▌</span>
      )}
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
