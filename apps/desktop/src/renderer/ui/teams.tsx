import { useEffect, useState } from "react";
import { useStore, teamMessages } from "@/renderer/state/store";
import { employeeName } from "@/renderer/ui/employee-name";
import { Modal } from "@/renderer/ui/modal";
import type { TeamMessage } from "@/shared/domain";

const NO_MESSAGES: readonly TeamMessage[] = [];

/** The Teams panel: each team's leader, members, and live chat room. */
export function Teams({ onClose }: { onClose: () => void }) {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const teams = useStore((s) => s.teams);
  const [rooms, setRooms] = useState<ReadonlyMap<string, TeamMessage[]>>(new Map());

  useEffect(() => {
    let live = true;
    void (async () => {
      const pairs = await Promise.all(
        teams.map(async (t) => [t.id, await teamMessages(t.id, 30)] as const),
      );
      if (live) setRooms(new Map(pairs));
    })();
    return () => {
      live = false;
    };
  }, [teams]);

  if (!company) return null;
  // The domain allows many teams; the game only ever founds one. Title and
  // count follow what's actually there rather than announcing a constant.
  const title = teams.length > 1 ? "Teams" : "Team";
  const headcount = `${employees.length} ${employees.length === 1 ? "person" : "people"}`;
  const subtitle = teams.length > 1 ? `${headcount} · ${teams.length} teams` : headcount;

  return (
    <Modal title={title} subtitle={subtitle} width="2xl" onClose={onClose}>
      <div className="space-y-3">
        {teams.length === 0 ? (
          <div className="text-sm text-text-dim">No teams yet.</div>
        ) : (
          teams.map((t) => {
            const members = employees.filter((e) => t.memberIds.includes(e.id));
            const room = rooms.get(t.id) ?? NO_MESSAGES;
            return (
              <div key={t.id} className="px-inset p-3">
                <div className="text-sm">{t.name}</div>
                {t.purpose ? <div className="mt-0.5 text-xs text-text-dim">{t.purpose}</div> : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {members.map((e) => (
                    <span
                      key={e.id}
                      className="px-plate px-2 py-0.5 text-xs"
                      title={e.title}
                      style={e.id === t.leaderId ? { color: "#e8d28a" } : undefined}
                    >
                      {e.id === t.leaderId ? "★ " : ""}
                      {e.name}
                    </span>
                  ))}
                </div>
                <div className="mt-3 text-xs uppercase tracking-wide text-text-dim">Team room</div>
                <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
                  {room.length === 0 ? (
                    <div className="text-xs text-text-dim">Quiet so far.</div>
                  ) : (
                    room.map((m) => (
                      <div key={m.id} className="text-xs leading-snug">
                        <span className="text-[#3a76b8]">
                          {employeeName(employees, m.fromEmployeeId, "founder")}
                        </span>
                        <span className="text-text">: {m.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
