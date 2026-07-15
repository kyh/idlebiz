import { useEffect, useRef, useState } from "react";
import { useStore, sendFounderChat } from "@/renderer/state/store";
import type { ActivityEvent } from "@/shared/domain";

const FEED_KINDS = new Set(["chat", "ship"]);
const ORG_EVENTS = new Set(["org.hired", "org.released", "runner.resting"]);

const inFeed = (a: ActivityEvent): boolean =>
  FEED_KINDS.has(a.kind) ||
  (a.kind === "lifecycle" && typeof a.message === "string" && ORG_EVENTS.has(a.message));

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed.length]);

  // hide while a dialogue/modal is up — a half-covered window reads as broken
  if (!company || modalOpen) return null;

  const nameOf = (id?: string | null): string =>
    id ? (employees.find((e) => e.id === id)?.name ?? "team") : "you";

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void sendFounderChat(text);
  };

  return (
    <div className="px-window pointer-events-auto absolute right-3 bottom-3 z-10 w-80">
      <div className="px-titlebar flex items-center justify-between px-3 py-1.5 text-[12px]">
        <span># team</span>
        <span className="text-[11px] text-[#c3c9de]">
          {company.autopilot ? "● live" : "paused"}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="px-inset px-scroll max-h-48 min-h-16 space-y-1 overflow-y-auto p-2 text-[12px] leading-snug"
      >
        {feed.length === 0 ? (
          <div className="text-[var(--text-dim)]">
            {company.autopilot ? "The team is getting to work…" : "Autopilot paused."}
          </div>
        ) : (
          feed.map((e, i) => <FeedRow key={e.id ?? i} e={e} name={nameOf(e.employeeId)} />)
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
          className="px-field min-w-0 flex-1 text-[12px]"
        />
        <button type="button" onClick={send} disabled={!draft.trim()} className="px-btn">
          <span className="px-icon px-icon-solo">➤</span>
        </button>
      </div>
    </div>
  );
}

function FeedRow({ e, name }: { e: ActivityEvent; name: string }) {
  if (e.kind === "ship") {
    return (
      <div style={{ color: "var(--accent-lo)" }}>
        📦 <span className="text-[var(--text)]">{name}</span> shipped: {e.message}
      </div>
    );
  }
  if (e.kind === "lifecycle") {
    const p: unknown = e.payload;
    const obj = typeof p === "object" && p !== null ? p : {};
    if (e.message === "runner.resting") {
      const until = "until" in obj && typeof obj.until === "number" ? obj.until : null;
      const at =
        until === null
          ? "later"
          : new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const runner = "runner" in obj && typeof obj.runner === "string" ? obj.runner : "a";
      return (
        <div className="text-[var(--text-dim)]">
          ☕ {runner} crew hit their limit — back at {at}
        </div>
      );
    }
    const who = "name" in obj && typeof obj.name === "string" ? obj.name : "someone";
    return (
      <div className="text-[var(--text-dim)]">
        {e.message === "org.hired" ? `🤝 ${who} joined the team` : `👋 ${who} left the team`}
      </div>
    );
  }
  const founder = name === "you";
  return (
    <div>
      <span style={{ color: founder ? "var(--warn)" : "var(--accent-lo)" }}>{name}</span>{" "}
      <span className="text-[#4c5064]">{e.message}</span>
    </div>
  );
}
