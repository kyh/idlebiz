import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/renderer/api";
import { hear } from "@/renderer/game/office-port";
import { useCompany, useEmployees } from "@/renderer/state/queries";
import { useStore, directEmployee, setTalkingTo } from "@/renderer/state/store";
import { useSubmission } from "@/renderer/hooks/use-submission";
import type { Submission } from "@/renderer/hooks/use-submission";
import { useTransientNote } from "@/renderer/hooks/use-transient-note";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { ActionCard } from "@/renderer/ui/action-card";
import { trailOf } from "@/renderer/ui/activity-trail";
import type { Said } from "@/renderer/ui/activity-trail";
import { AnswerForm } from "@/renderer/ui/answer-form";
import { RichText } from "@/renderer/ui/linkify";
import { useModal } from "@/renderer/ui/modal";
import { ChoiceMenu } from "@/renderer/ui/choice-menu";
import type { Menu } from "@/renderer/ui/choice-menu";
import { Bust } from "@/renderer/ui/bust";
import { jobTitle } from "@/renderer/ui/employee-name";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import { TypeCursor } from "@/renderer/ui/type-cursor";
import type { ActivityEvent, ActivityKind } from "@repo/domain/activity";
import { taskIn } from "@repo/domain/domain";
import type { ChatOption, Employee, Task } from "@repo/domain/domain";
import { cn } from "cn";

const NOTE_MS = 1800;

const HINTS = {
  menu: "↑↓ move · ⏎ select · esc leave",
  talk: "⏎ send · esc back",
};

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
/** Main's option labels are distinct, so a label names its row wherever the list moves it. */
const keyOf = (row: Row): string => (row.kind === "ask" ? `ask:${row.option.label}` : row.kind);

const SPEECH_CLASS = "text-sm leading-relaxed break-words text-fg";
const Speech = ({ text }: { text: string }) => {
  const { shown, done, skip } = useTypewriter(text);
  if (done) {
    return (
      <div className={SPEECH_CLASS} style={{ cursor: "default" }}>
        <RichText text={text} />
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
  <form
    className="flex items-center gap-2"
    onSubmit={(e) => {
      e.preventDefault();
      onSubmit();
    }}
  >
    <input
      value={value}
      readOnly={sending}
      onChange={(e) => onChange(e.target.value)}
      placeholder={`Tell ${name} what to do…`}
      className="px-field flex-1"
      autoFocus
    />
    <button type="submit" disabled={!value.trim() || sending} className="px-btn-accent px-btn">
      {sending ? "Sending…" : "Send"}
    </button>
  </form>
);

const SendStatus = ({ submission, note }: { submission: Submission; note: string | null }) => {
  if (submission.kind === "failed") {
    return (
      <div role="alert" className="mt-1 text-center text-xs text-danger">
        Could not send: {submission.message}
      </div>
    );
  }
  if (submission.kind !== "sending" && note) {
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

const FeedLine = ({ e }: { e: Said }) => {
  const { color, prefix } = LINE_STYLES.get(e.kind) ?? QUIET_LINE;
  return (
    <div className="break-words" style={{ color }}>
      {prefix}
      <RichText text={e.message.slice(0, 300)} />
    </div>
  );
};

const NO_TASKS: Task[] = [];
const NO_OPTIONS: ChatOption[] = [];

const DialoguePanel = ({ emp, onClose }: { emp: Employee; onClose: () => void }) => {
  useModal();
  const company = useCompany();
  const activity = useStore((s) => s.activity);
  const [mode, setMode] = useState<"menu" | "talk">("menu");
  // The cursor names a row, not a place: rows come and go around it, and a menu
  // remounted after Talk… would otherwise land on whatever now sits at the old index.
  const [chosen, setChosen] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [note, showNote] = useTransientNote(NOTE_MS);

  const mine = useMemo(
    () => activity.filter((a) => "employeeId" in a && a.employeeId === emp.id),
    [activity, emp.id],
  );
  // read again whenever an event moves the company's tasks, the open form staying up meanwhile
  const listed = useQuery({
    ...orpc.tasks.list.queryOptions({
      input: { assigneeId: emp.id, status: ["queued", "running", "blocked"] },
    }),
    enabled: company !== null,
  });
  const offered = useQuery(orpc.employees.options.queryOptions({ input: { employeeId: emp.id } }));
  const tasks = listed.data ?? NO_TASKS;
  const options = offered.data ?? NO_OPTIONS;

  // only questions and actions are answered here; integration asks live in the
  // inbox where the [Connect] button is. A stale list still shows its ask: any
  // event that moves their tasks makes it stale, and dropping the form until the
  // refetch lands would wipe what the founder is typing. An answered form stays
  // sent, and main refuses an ask answered elsewhere.
  const asked = tasks
    .filter(taskIn("blocked"))
    .find((t) => t.state.ask.type === "question" || t.state.ask.type === "action");
  // the menu: main's options for this employee, then Talk… for free text. It
  // waits for the options so it opens on the first one, not on Talk.
  const rows: Row[] = [
    ...options.map((option): Row => ({ kind: "ask", option })),
    { kind: "talk" },
    { kind: "leave" },
  ];

  // everything the founder says goes through the team channel; the @slug
  // mention wakes exactly this employee with the message as their brief
  const { submission, submit } = useSubmission(
    async (said: { instruction: string; typed: boolean }) => {
      await directEmployee(emp.id, said.instruction);
      showNote(`Sent to ${emp.name} ✓`);
      if (said.typed) {
        setInput("");
        setMode("menu");
      }
    },
  );
  const send = (instruction: string, typed = false): void => {
    if (submission.kind !== "sending") {
      submit({ instruction, typed });
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
        send(row.option.instruction);
        break;
      }
      // no default
    }
  };

  const submitTalk = () => {
    const text = input.trim();
    if (text) {
      send(text, true);
    }
  };

  const sending = submission.kind === "sending";
  const at = rows.findIndex((row) => keyOf(row) === chosen);
  const menu: Menu = {
    cursor: Math.max(0, at),
    items: rows.map((row) => ({ disabled: sending, label: labelOf(row) })),
    pick: choose,
    setCursor: (i) => {
      const row = rows[i];
      if (row) {
        setChosen(keyOf(row));
      }
    },
  };

  // the choice window walks and picks itself; Escape backs out of Talk, then leaves
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing) {
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
    window.addEventListener("keydown", onKey);
    return () => {
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
  const trail = trailOf(mine, latest);
  const working = emp.status === "working";
  const running = tasks.find((t) => t.state.kind === "running" || t.state.kind === "queued");
  const speech = speechFor(latest, working, running);

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-6">
      <div className="dlg">
        {mode === "menu" && !listed.isPending && !offered.isPending ? (
          <ChoiceMenu menu={menu} className="dlg-menu" refocusKey={asked?.id ?? null} />
        ) : null}
        <div className="px-battle px-pop dlg-box">
          <div className="dlg-bust">
            <Bust seed={emp.spriteSeed} size="lg" alt={emp.name} />
          </div>
          <div className="dlg-body">
            <EmployeeTag name={emp.name} title={jobTitle(emp)} status={emp.status} size="lg" />
            {asked ? (
              <div className="px-scroll min-h-0 overflow-y-auto">
                {asked.state.ask.type === "action" ? (
                  <ActionCard key={asked.id} t={asked} by={emp.name} ask={asked.state.ask} />
                ) : null}
                {asked.state.ask.type === "question" ? (
                  <div className="px-inset px-inset-warn p-2.5">
                    <div className="text-xs text-danger">❗ {emp.name} needs your call:</div>
                    <div className="mt-1 text-sm leading-snug whitespace-pre-wrap text-fg">
                      <RichText text={asked.state.ask.question} />
                    </div>
                    <AnswerForm
                      key={asked.id}
                      task={asked}
                      autoFocus={mode === "menu"}
                      onSent={() => showNote("Answer sent ✓")}
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="px-scroll flex min-h-[64px] flex-1 flex-col overflow-y-auto">
                <Speech key={latest?.id ?? "flavor"} text={speech.slice(0, 280)} />
                {trail.length > 0 ? (
                  <div className="mt-auto space-y-0.5 pt-2 text-xs leading-snug opacity-70">
                    {trail.map((a) => (
                      <FeedLine key={a.id} e={a} />
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
                  submitTalk();
                }}
              />
            ) : null}
            <SendStatus submission={submission} note={note} />
            <div className="px-hint mt-auto text-right">{HINTS[mode]}</div>
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
  const employees = useEmployees();
  const talkingTo = useStore((s) => s.talkingTo);

  // walking up to someone in the office opens the same conversation the roster does
  useEffect(() => {
    if (!game) {
      return;
    }
    return hear(game, "npc-interact", ({ employeeId }) => setTalkingTo(employeeId));
  }, [game]);

  const emp = employees.find((e) => e.id === talkingTo);
  if (!emp) {
    return null;
  }
  return <DialoguePanel key={emp.id} emp={emp} onClose={() => setTalkingTo(null)} />;
};
