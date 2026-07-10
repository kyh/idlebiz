import { useEffect, useState } from "react";
import { useStore, setModalOpen, teamMessages } from "@/renderer/state/store";
import type { TeamMessage } from "@/shared/domain";

/** The Teams panel: each team's leader, members, and live chat room. */
export function Teams({ onClose }: { onClose: () => void }) {
  const { company, employees, teams } = useStore();
  const [rooms, setRooms] = useState<Record<string, TeamMessage[]>>({});

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      const pairs = await Promise.all(
        teams.map(async (t) => [t.id, await teamMessages(t.id, 30)] as const),
      );
      if (live) setRooms(Object.fromEntries(pairs));
    };
    void load();
    return () => {
      live = false;
    };
  }, [teams]);

  if (!company) return null;
  const nameOf = (id: string | null): string =>
    employees.find((e) => e.id === id)?.name ?? "founder";

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className="px-window flex max-h-[80vh] w-full max-w-2xl flex-col">
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div>
            <div className="text-[16px]">Teams</div>
            <div className="text-[12px] text-[#c4c9dd]">
              {teams.length} team{teams.length === 1 ? "" : "s"} · {employees.length} people
            </div>
          </div>
          <button onClick={onClose} className="px-btn">
            Done
          </button>
        </div>
        <div className="px-scroll flex-1 space-y-3 overflow-y-auto p-4">
          {teams.length === 0 ? (
            <div className="text-[13px] text-[var(--text-dim)]">No teams yet.</div>
          ) : (
            teams.map((t) => {
              const members = employees.filter((e) => t.memberIds.includes(e.id));
              const room = rooms[t.id] ?? [];
              return (
                <div key={t.id} className="px-inset p-3">
                  <div className="text-[14px]">{t.name}</div>
                  {t.purpose ? (
                    <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">{t.purpose}</div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {members.map((e) => (
                      <span
                        key={e.id}
                        className="px-plate px-2 py-0.5 text-[11px]"
                        title={e.title}
                        style={e.id === t.leaderId ? { color: "#e8d28a" } : undefined}
                      >
                        {e.id === t.leaderId ? "★ " : ""}
                        {e.name}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
                    Team room
                  </div>
                  <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
                    {room.length === 0 ? (
                      <div className="text-[12px] text-[var(--text-dim)]">Quiet so far.</div>
                    ) : (
                      room.map((m) => (
                        <div key={m.id} className="text-[12px] leading-snug">
                          <span className="text-[#3a76b8]">{nameOf(m.fromEmployeeId)}</span>
                          <span className="text-[var(--text)]">: {m.text}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
