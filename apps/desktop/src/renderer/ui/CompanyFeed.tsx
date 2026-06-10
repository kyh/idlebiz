import { useStore } from "@/renderer/state/store";
import type { ActivityEvent } from "@/shared/domain";

/** A live company "team channel": agents' chat + shipped work, so you can watch
 *  the business run itself. */
export function CompanyFeed() {
  const { employees, activity, company } = useStore();
  if (!company) return null;

  const nameOf = (id?: string | null): string => employees.find((e) => e.id === id)?.name ?? "team";
  const feed = activity.filter((a) => a.kind === "chat" || a.kind === "ship").slice(-7);

  return (
    <div className="px-window pointer-events-none absolute bottom-12 left-3 z-10 w-72">
      <div className="px-titlebar flex items-center justify-between px-3 py-1.5 text-[11px]">
        <span>Team channel</span>
        <span className="text-[10px] text-[#aab0c8]">
          {company.autopilot ? "● live" : "paused"}
        </span>
      </div>
      <div className="px-inset px-scroll max-h-44 space-y-1 overflow-y-auto p-2 text-[11px] leading-snug">
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
      <span className="text-[#54586c]">{e.message}</span>
    </div>
  );
}
