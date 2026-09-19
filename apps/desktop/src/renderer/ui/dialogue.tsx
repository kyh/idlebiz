import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { bridge } from "@/renderer/bridge";
import { useStore, directEmployee, listTasksFor, setTalkingTo } from "@/renderer/state/store";
import { useAsync } from "@/renderer/hooks/use-async";
import { useTransientNote } from "@/renderer/hooks/use-transient-note";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { AnswerForm } from "@/renderer/ui/answer-form";
import { RichText } from "@/renderer/ui/linkify";
import { useModal } from "@/renderer/ui/modal";
import { ChoiceMenu } from "@/renderer/ui/choice-menu";
import type { Menu } from "@/renderer/ui/choice-menu";
import { Bust } from "@/renderer/ui/bust";
import { jobTitle } from "@/renderer/ui/employee-name";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import { TypeCursor } from "@/renderer/ui/type-cursor";
import type { ActivityEvent, ActivityKind } from "@/shared/activity";
import { taskIn } from "@/shared/domain";
import type { Employee } from "@/shared/domain";
import type { ChatOption } from "@/shared/ipc-registry";
import { errorMessage } from "@/shared/errors";
import { cn } from "cn";

const NOTE_MS = 1800;

type Submission = { kind: "ready" } | { kind: "sending" } | { kind: "failed"; message: string };
type Spoken = Extract<ActivityEvent, { kind: "chat" | "message" | "ship" }>;

const isSpoken = (a: ActivityEvent): a is Spoken =>
  a.kind === "chat" || a.kind === "message" || a.kind === "ship";

// what they SAY: the latest real utterance; with none, a line
// about what they're doing
const speechFor = (
  latest: Spoken | undefined,
  working: boolean,
  running: { title: string } | undefined,
): string => {
  if (latest) {
    return latest.kind === "ship" ? `Shipped it! ${latest.message}` : latest.message;
  }
  if (!working) {
    return "All quiet. What should I do next?";
  }
  return running ? `On it — "${running.title}".` : "Heads down on something right now.";
};

type Row = { kind: "ask"; option: ChatOption } | { kind: "talk" } | { kind: "leave" };
const labelOf = (row: Row): string => {
  switch (row.kind) {
    case "ask": {
      return row.option.label;
    }
    case "talk": {
      return "Talk…";
    }
    case "leave": {
      return "Leave";
    }
    // no default
  }
};

const SPEECH_CLASS = "text-sm leading-relaxed break-words text-fg";
const Speech = ({ text, companyId }: { text: string; companyId: string }) => {
  const { shown, done, skip } = useTypewriter(text);
  if (done) {
    return (
      <div className={SPEECH_CLASS} style={{ cursor: "default" }}>
        <RichText text={text} companyId={companyId} />
        <TypeCursor done more />
      </div>
    );
  }
  return (
    <button type="button" onClick={skip} className={cn(SPEECH_CLASS, "block w-full text-left")}>
      {shown}
      <TypeCursor done={false} more={false} />
    </button>
  );
};

const TalkInput = ({
  name,
  value,
  sending,
  onChange,
  onSubmit,
}: {
  name: string;
  value: string;
  sending: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) => (
  <div className="flex items-center gap-2">
    <input
      value={value}
      disabled={sending}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        }
      }}
      placeholder={`Tell ${name} what to do…`}
      className="px-field flex-1"
      autoFocus
    />
    <button
      type="button"
      onClick={onSubmit}
      disabled={!value.trim() || sending}
      className="px-btn-accent px-btn"
    >
      {sending ? "Sending…" : "Send"}
    </button>
  </div>
);

const SendStatus = ({ submission, note }: { submission: Submission; note: string | null }) => {
  if (submission.kind === "failed") {
    return (
      <div role="alert" className="mt-1 text-center text-xs text-danger">
        Could not send: {submission.message}
      </div>
    );
  }
  if (submission.kind === "ready" && note) {
    return <div className="mt-1 text-center text-xs text-ok">{note}</div>;
  }
  return null;
};

interface LineStyle {
  color: string;
  prefix: string;
}
const LINE_STYLES = new Map<ActivityKind, LineStyle>([
  ["tool_call", { color: "#2f6fb0", prefix: "⚙ " }],
  ["message", { color: "#2b2f46", prefix: "💬 " }],
  ["ship", { color: "#2e8a4e", prefix: "📦 " }],
  ["chat", { color: "#5a4fae", prefix: "🗨 " }],
  ["status", { color: "#6d7187", prefix: "› " }],
]);
const QUIET_LINE: LineStyle = { color: "#6d7187", prefix: "· " };

const FeedLine = ({ e, companyId }: { e: ActivityEvent; companyId: string }) => {
  const { color, prefix } = LINE_STYLES.get(e.kind) ?? QUIET_LINE;
  const text = "message" in e ? e.message : e.kind;
  return (
    <div className="break-words" style={{ color }}>
      {prefix}
      <RichText text={text.slice(0, 300)} companyId={companyId} />
    </div>
  );
};

const DialoguePanel = ({ emp, onClose }: { emp: Employee; onClose: () => void }) => {
  useModal();
  const company = useStore((s) => s.company);
  const activity = useStore((s) => s.activity);
  const [mode, setMode] = useState<"menu" | "talk">("menu");
  const [sel, setSel] = useState(0);
  const [input, setInput] = useState("");
  const [submission, setSubmission] = useState<Submission>({ kind: "ready" });
  const [note, showNote] = useTransientNote(NOTE_MS);
  const mounted = useRef(false);

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
    { kind: "leave" },
  ];

  // everything the founder says goes through the team channel; the @slug
  // mention wakes exactly this employee with the message as their brief
  const send = async (instruction: string): Promise<boolean> => {
    if (submission.kind === "sending") {
      return false;
    }
    setSubmission({ kind: "sending" });
    try {
      await directEmployee(emp.id, instruction);
      if (!mounted.current) {
        return false;
      }
      setSubmission({ kind: "ready" });
      showNote(`Sent to ${emp.name} ✓`);
      return true;
    } catch (error) {
      if (mounted.current) {
        setSubmission({ kind: "failed", message: errorMessage(error) });
      }
      return false;
    }
  };

  const choose = (i: number) => {
    if (submission.kind === "sending") {
      return;
    }
    const row = rows[i];
    if (!row) {
      return;
    }
    switch (row.kind) {
      case "talk": {
        setMode("talk");
        break;
      }
      case "leave": {
        onClose();
        break;
      }
      case "ask": {
        void send(row.option.instruction);
        break;
      }
      // no default
    }
  };

  const submitTalk = async () => {
    const text = input.trim();
    if (!text) {
      return;
    }
    if (await send(text)) {
      setInput("");
      setMode("menu");
    }
  };

  const sending = submission.kind === "sending";
  const menu: Menu = {
    cursor: sel,
    items: rows.map((row) => ({ disabled: sending, label: labelOf(row) })),
    pick: choose,
    setCursor: setSel,
  };

  // the choice window walks and picks itself; Escape backs out of Talk, then leaves
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== "Escape") {
      return;
    }
    e.preventDefault();
    if (mode === "talk") {
      setMode("menu");
    } else {
      onClose();
    }
  });
  useEffect(() => {
    mounted.current = true;
    window.addEventListener("keydown", onKey);
    return () => {
      mounted.current = false;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!company) {
    return null;
  }
  // what they SAY: the latest real utterance (chat/message/ship)
  const spoken = mine.filter(isSpoken).filter((a) => a.message);
  const latest = spoken.at(-1);
  // what they're DOING: everything else stays a compact activity trail
  const trail: ActivityEvent[] = mine.filter((a) => a !== latest).slice(-3);
  const working = emp.status === "working";
  const running = tasks.find((t) => t.state.kind === "running" || t.state.kind === "queued");
  const speech = speechFor(latest, working, running);

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-6">
      <div className="dlg">
        {mode === "menu" ? <ChoiceMenu menu={menu} className="dlg-menu" /> : null}
        <div className="px-battle px-pop dlg-box">
          <div className="dlg-bust">
            <Bust seed={emp.spriteSeed} size="lg" alt={emp.name} />
          </div>
          <div className="dlg-body">
            <EmployeeTag name={emp.name} title={jobTitle(emp)} status={emp.status} size="lg" />
            {asked && question !== null ? (
              <div className="px-inset p-2.5" style={{ borderColor: "var(--warn)" }}>
                <div className="text-xs text-danger">❗ {emp.name} needs your call:</div>
                <div className="mt-1 text-sm leading-snug text-fg">
                  <RichText text={question} companyId={company.id} />
                </div>
                <AnswerForm task={asked} autoFocus onSent={() => showNote("Answer sent ✓")} />
              </div>
            ) : (
              <div className="px-scroll flex min-h-[64px] flex-1 flex-col overflow-y-auto">
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
            {mode === "talk" ? (
              <TalkInput
                name={emp.name}
                value={input}
                sending={sending}
                onChange={setInput}
                onSubmit={() => {
                  void submitTalk();
                }}
              />
            ) : null}
            <SendStatus submission={submission} note={note} />
            <div className="px-hint mt-auto text-right">
              {mode === "talk" ? "⏎ send · esc back" : "↑↓ move · ⏎ select · esc leave"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Leave (esc)"
            className="absolute top-0 right-0 p-2.5 text-sm leading-none text-fg-dim hover:text-fg"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
};

export const Dialogue = () => {
  const game = useStore((s) => s.game);
  const employees = useStore((s) => s.employees);
  const talkingTo = useStore((s) => s.talkingTo);

  // walking up to someone in the office opens the same conversation the roster does
  useEffect(() => {
    if (!game) {
      return;
    }
    const onInteract = (p: { employeeId: string }) => setTalkingTo(p.employeeId);
    game.events.on("npc-interact", onInteract);
    return () => {
      game.events.off("npc-interact", onInteract);
    };
  }, [game]);

  const emp = employees.find((e) => e.id === talkingTo);
  if (!emp) {
    return null;
  }
  return <DialoguePanel key={emp.id} emp={emp} onClose={() => setTalkingTo(null)} />;
};
