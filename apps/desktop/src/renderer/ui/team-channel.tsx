import { useEffect, useRef, useState } from "react";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { useStore, sendFounderChat } from "@/renderer/state/store";
import { ApprovalButtons, useApproval } from "@/renderer/ui/approval";
import { employeeName } from "@/renderer/ui/employee-name";
import { Failure } from "@/renderer/ui/failure";
import { feedKey, newestOf } from "@/renderer/state/activity-reducer";
import type { FeedLine } from "@/renderer/state/activity-reducer";
import { INTEGRATION_LABELS } from "@repo/domain/domain";
import type { BlockedAsk } from "@repo/domain/domain";
import { formatTime } from "@repo/domain/format";
import { describeRule, shownKey } from "@repo/domain/hold-rules";
import { cn } from "cn";

// The teammate says in the room that a command waits on the founder, so the answer sits beside it.
const HeldCommand = ({
  taskId,
  by,
  command,
  rule,
}: {
  taskId: string;
  by: string;
  command: string;
  rule: string;
}) => {
  const { submission, decided, decide } = useApproval(taskId);
  return (
    <div className={cn("px-inset p-2 text-xs leading-snug", decided && "opacity-50")}>
      <div className="text-warn">
        🔐 {by} · <span className="text-fg-dim">{describeRule(rule)}</span>
      </div>
      <code className="px-code mt-1 block">{shownKey(command)}</code>
      <div className="mt-1.5 flex justify-end">
        <ApprovalButtons decided={decided} decide={decide} />
      </div>
      <Failure submission={submission} />
    </div>
  );
};

/** What a teammate is waiting on the founder for, after their name; the card to answer it is in the inbox. */
const askLine = (ask: BlockedAsk): string => {
  switch (ask.type) {
    case "question": {
      return `asks: ${ask.question}`;
    }
    case "action": {
      return `needs you to: ${ask.action}`;
    }
    case "integration": {
      return ask.integration === "stripe-key"
        ? "needs a Stripe key"
        : `needs ${INTEGRATION_LABELS[ask.integration]} connected`;
    }
    case "approval": {
      return `needs your sign-off: ${describeRule(ask.rule)}`;
    }
    // no default
  }
};

const RoomRow = ({
  line: { from, text },
  nameOf,
}: {
  line: Extract<FeedLine, { kind: "room" }>;
  nameOf: (id: string) => string;
}) => {
  if (from.kind === "office") {
    return <div className="text-fg-dim">{text}</div>;
  }
  return (
    <div>
      {from.kind === "founder" ? (
        <span style={{ color: "var(--warn)" }}>you</span>
      ) : (
        <span style={{ color: "var(--accent-lo)" }}>{nameOf(from.id)}</span>
      )}{" "}
      <span className="text-[#4c5064]">{text}</span>
    </div>
  );
};

const NewsRow = ({
  e,
  nameOf,
}: {
  e: Extract<FeedLine, { kind: "news" }>["event"];
  nameOf: (id: string) => string;
}) => {
  switch (e.kind) {
    case "ship": {
      return (
        <div style={{ color: "var(--accent-lo)" }}>
          📦 <span className="text-fg">{nameOf(e.employeeId)}</span> shipped: {e.message}
        </div>
      );
    }
    case "runner.resting": {
      return e.payload.cause === "access-denied" ? (
        <div className="line-clamp-2 text-fg-dim">
          🔒 {e.payload.runner}&apos;s provider refused access, and signing in again won&apos;t fix
          it: {e.payload.error} — trying again at {formatTime(e.payload.until)}
        </div>
      ) : (
        <div className="text-fg-dim">
          ☕ {e.payload.runner} crew hit their limit — back at {formatTime(e.payload.until)}
        </div>
      );
    }
    case "org.hired": {
      return <div className="text-fg-dim">🤝 {e.payload.name} joined the team</div>;
    }
    case "org.released": {
      return <div className="text-fg-dim">👋 {e.payload.name} left the team</div>;
    }
    case "run.ask": {
      return (
        <div className="line-clamp-2 text-fg-dim">
          <span className="text-fg">{nameOf(e.employeeId)}</span> {askLine(e.payload.ask)}
        </div>
      );
    }
    // no default
  }
};

export const TeamChannel = () => {
  const employees = useStore((s) => s.employees);
  const feed = useStore((s) => s.feed);
  const pendingAsks = useStore((s) => s.pendingAsks);
  const company = useStore((s) => s.company);
  const modalOpen = useStore((s) => s.modalOpen);
  const [draft, setDraft] = useState("");
  const { submission, submit } = useSubmission(async (text: string) => {
    await sendFounderChat(text);
    setDraft("");
  });
  const [focused, setFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // keyed on the newest line, not the count — the feed is capped, so the
  // length stops changing once it fills and auto-scroll would die there.
  const newest = newestOf(feed);
  // hide while a dialogue/modal is up — a half-covered window reads as broken
  const shown = company !== null && !modalOpen;

  // and on every showing too: the feed comes back as a new box, scrolled to its top
  useEffect(() => {
    if (newest === null || !shown) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [newest, shown]);

  if (!company || !shown) {
    return null;
  }

  const nameOf = (id: string): string => employeeName(employees, id, "team");
  const held = pendingAsks.flatMap((t) =>
    t.state.ask.type === "approval"
      ? [{ command: t.state.ask.command, rule: t.state.ask.rule, t }]
      : [],
  );

  // The field goes readOnly while a send is in flight, never disabled: a disabled
  // field drops focus, and the office takes the keys the founder types next.
  const send = () => {
    const text = draft.trim();
    if (text && submission.kind !== "sending") {
      submit(text);
    }
  };

  return (
    <div className="px-window pointer-events-auto absolute right-3 bottom-3 z-10 w-80">
      <div className="px-titlebar flex items-center justify-between px-3 py-1.5 text-xs">
        <span># team</span>
        <span className="text-xs text-[#c3c9de]">{company.autopilot ? "● live" : "paused"}</span>
      </div>
      <div
        ref={scrollRef}
        className="px-inset px-scroll max-h-48 min-h-16 space-y-1 overflow-y-auto p-2 text-xs leading-snug"
      >
        {feed.length === 0 ? (
          <div className="text-fg-dim">
            {company.autopilot ? "The team is getting to work…" : "Autopilot paused."}
          </div>
        ) : (
          feed.map((line) =>
            line.kind === "room" ? (
              <RoomRow key={feedKey(line)} line={line} nameOf={nameOf} />
            ) : (
              <NewsRow key={feedKey(line)} e={line.event} nameOf={nameOf} />
            ),
          )
        )}
      </div>
      {held.length > 0 ? (
        <div className="px-scroll max-h-40 space-y-1 overflow-y-auto px-1.5 pt-1.5">
          {held.map(({ t, command, rule }) => (
            <HeldCommand
              key={t.id}
              taskId={t.id}
              by={employeeName(employees, t.assigneeId, "someone")}
              command={command}
              rule={rule}
            />
          ))}
        </div>
      ) : null}
      <div className="flex gap-1 p-1.5">
        <input
          value={draft}
          readOnly={submission.kind === "sending"}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={focused ? "@name wakes them up" : "Message the team…"}
          className="px-field min-w-0 flex-1"
        />
        <button
          type="button"
          onClick={() => {
            send();
          }}
          disabled={!draft.trim() || submission.kind === "sending"}
          aria-label={submission.kind === "sending" ? "Sending message" : "Send message"}
          className="px-btn"
        >
          <span className="px-icon px-icon-solo">➤</span>
        </button>
      </div>
      {submission.kind === "failed" ? (
        <div role="alert" className="px-2 pb-2 text-xs text-danger">
          Could not send: {submission.message}
        </div>
      ) : null}
    </div>
  );
};
