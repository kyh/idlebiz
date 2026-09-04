import { useEffect, useRef, useState } from "react";
import { useStore, sendFounderChat } from "@/renderer/state/store";
import { employeeName } from "@/renderer/ui/employee-name";
import type { ActivityEvent, ActivityKind } from "@/shared/activity";
import { formatTime } from "@/shared/format";

/** What the room shows: what people said, shipped, and who came and went. */
const FEED_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  "chat",
  "ship",
  "org.hired",
  "org.released",
  "runner.resting",
]);

const inFeed = (a: ActivityEvent): boolean => FEED_KINDS.has(a.kind);

/**
 * The team channel (bottom-right): a live room the founder is actually in.
 * Agents' chatter, ships and org changes stream here; typing posts to the
 * room, and @first-name wakes that employee with the message.
 */
export function TeamChannel() {
  const { employees, activity, company, modalOpen } = useStore();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const feed = activity.filter(inFeed).slice(-30);
  // keyed on the newest event, not the count — the feed is capped at 30, so the
  // length stops changing once it fills and auto-scroll would die there.
  const newest = feed.at(-1)?.createdAt ?? null;

  useEffect(() => {
    if (newest === null) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [newest]);

  // hide while a dialogue/modal is up — a half-covered window reads as broken
  if (!company || modalOpen) return null;

  const nameOf = (id?: string | null): string => (id ? employeeName(employees, id, "team") : "you");

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendFounderChat(text);
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
          <div className="text-[var(--text-dim)]">
            {company.autopilot ? "The team is getting to work…" : "Autopilot paused."}
          </div>
        ) : (
          feed.map((e) => <FeedRow key={e.id} e={e} name={nameOf(e.employeeId)} />)
        )}
      </div>
      <div className="flex gap-1 p-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          placeholder={focused ? "@name wakes them up" : "Message the team…"}
          className="px-field min-w-0 flex-1"
        />
        <button type="button" onClick={send} disabled={!draft.trim()} className="px-btn">
          <span className="px-icon px-icon-solo">➤</span>
        </button>
      </div>
    </div>
  );
}

function FeedRow({ e, name }: { e: ActivityEvent; name: string }) {
  switch (e.kind) {
    case "ship":
      return (
        <div style={{ color: "var(--accent-lo)" }}>
          📦 <span className="text-[var(--text)]">{name}</span> shipped: {e.message}
        </div>
      );
    case "runner.resting":
      return (
        <div className="text-[var(--text-dim)]">
          ☕ {e.payload.runner} crew hit their limit — back at {formatTime(e.payload.until)}
        </div>
      );
    case "org.hired":
      return <div className="text-[var(--text-dim)]">🤝 {e.payload.name} joined the team</div>;
    case "org.released":
      return <div className="text-[var(--text-dim)]">👋 {e.payload.name} left the team</div>;
    case "chat": {
      const founder = e.employeeId == null;
      return (
        <div>
          <span style={{ color: founder ? "var(--warn)" : "var(--accent-lo)" }}>{name}</span>{" "}
          <span className="text-[#4c5064]">{e.message}</span>
        </div>
      );
    }
    default:
      return null;
  }
}
