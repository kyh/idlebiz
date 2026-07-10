import { useStore } from "@/renderer/state/store";
import type { ActivityEvent } from "@/shared/domain";

/** A live company "team channel": agents' chat + shipped work, so you can watch
 *  the business run itself. */
export function CompanyFeed() {
  const { employees, activity, company, modalOpen } = useStore();
  // hide while a dialogue/modal is up — a half-covered window reads as broken
  if (!company || modalOpen) return null;

  const nameOf = (id?: string | null): string => employees.find((e) => e.id === id)?.name ?? "team";
  const feed = activity.filter((a) => a.kind === "chat" || a.kind === "ship").slice(-7);

  return (
    <div className="px-window pointer-events-none absolute right-3 bottom-14 z-10 w-80">
      <div className="px-titlebar flex items-center justify-between px-3 py-1.5 text-[12px]">
        <span>Team channel</span>
        <span className="text-[11px] text-[#c3c9de]">
          {company.autopilot ? "● live" : "paused"}
        </span>
      </div>
      <div className="px-inset px-scroll max-h-48 space-y-1 overflow-y-auto p-2 text-[12px] leading-snug">
        {feed.length === 0 ? (
          <div className="text-[var(--text-dim)]">
            {company.autopilot ? "The team is getting to work…" : "Autopilot paused."}
          </div>
        ) : (
          feed.map((e, i) => <FeedRow key={e.id ?? i} e={e} name={nameOf(e.employeeId)} />)
        )}
      </div>
    </div>
  );
}

function FeedRow({ e, name }: { e: ActivityEvent; name: string }) {
  if (e.kind === "ship") {
    return (
      <div className="truncate" style={{ color: "var(--accent-lo)" }}>
        📦 <span className="text-[var(--text)]">{name}</span> shipped: {e.message}
      </div>
    );
  }
  return (
    <div className="truncate">
      <span style={{ color: "var(--accent-lo)" }}>{name}</span>{" "}
      <span className="text-[#4c5064]">{e.message}</span>
    </div>
  );
}
