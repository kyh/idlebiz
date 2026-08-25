import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useStore, sendFounderChat } from "@/renderer/state/store";
import type { ActivityEvent } from "@/shared/domain";
import { formatTime } from "@/shared/format";

const FEED_KINDS = new Set(["chat", "ship"]);
const ORG_EVENTS = new Set(["org.hired", "org.released", "runner.resting"]);

// Lifecycle payloads parsed at the feed boundary; each field falls back
// independently, and a non-object payload falls back wholesale.
const LifecyclePayloadSchema = z
  .object({
    until: z.number().nullable().catch(null),
    runner: z.string().catch("a"),
    name: z.string().catch("someone"),
  })
  .catch({ until: null, runner: "a", name: "someone" });

const inFeed = (a: ActivityEvent): boolean =>
  FEED_KINDS.has(a.kind) ||
  (a.kind === "lifecycle" && a.message != null && ORG_EVENTS.has(a.message));

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
  if (e.kind === "ship") {
    return (
      <div style={{ color: "var(--accent-lo)" }}>
        📦 <span className="text-[var(--text)]">{name}</span> shipped: {e.message}
      </div>
    );
  }
  if (e.kind === "lifecycle") {
    const p = LifecyclePayloadSchema.parse(e.payload);
    if (e.message === "runner.resting") {
      const at = p.until === null ? "later" : formatTime(p.until);
      return (
        <div className="text-[var(--text-dim)]">
          ☕ {p.runner} crew hit their limit — back at {at}
        </div>
      );
    }
    return (
      <div className="text-[var(--text-dim)]">
        {e.message === "org.hired" ? `🤝 ${p.name} joined the team` : `👋 ${p.name} left the team`}
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
