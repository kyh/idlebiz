import { useEffect, useState } from "react";
import { useStore, setModalOpen, resetGame } from "@/renderer/state/store";

/** Game settings. Mostly the danger zone: demolish the office and start over. */
export function Settings({ onClose }: { onClose: () => void }) {
  const { company } = useStore();
  const [confirm, setConfirm] = useState("");
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  if (!company) return null;
  const armed = confirm.trim() === company.name;

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className="px-window flex w-full max-w-xl flex-col">
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div className="text-[16px]">Settings</div>
          <button onClick={onClose} className="px-btn" disabled={resetting}>
            Done
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div className="px-inset p-3 text-[13px] text-[var(--text)]">
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
              Company
            </div>
            <div className="mt-1">{company.name}</div>
            <div className="text-[12px] text-[var(--text-dim)]">{company.mission}</div>
            <div className="mt-1 truncate text-[12px] text-[var(--text-dim)]">
              {company.workspaceDir}
            </div>
          </div>

          <div className="px-inset p-3 text-[13px] text-[var(--text)]">
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
              Controls
            </div>
            <div className="mt-1 text-[12px] text-[var(--text-dim)]">
              WASD / arrows to move · walk up to someone and press E
            </div>
          </div>

          <div className="px-inset p-3 text-[13px] text-[var(--text)]">
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">Tools</div>
            <div className="mt-2 flex gap-2">
              <a href="#/ui" className="px-btn inline-block">
                Open office builder
              </a>
              <a href="#/office-assets" className="px-btn inline-block">
                Asset catalog
              </a>
            </div>
          </div>

          <div className="px-inset p-3" style={{ borderColor: "var(--danger)" }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--danger)" }}>
              Danger zone
            </div>
            <div className="mt-1 text-[13px] leading-snug text-[var(--text)]">
              Reset demolishes the office: every employee, task, and workspace file your team
              created, plus your OpenAI connection. The game restarts from scratch. There is no
              undo.
            </div>
            {resetting ? (
              <div className="px-live-dot mt-3 text-[14px]" style={{ color: "var(--danger)" }}>
                Demolishing the office…
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={`Type "${company.name}" to confirm`}
                  className="px-field min-w-0 flex-1"
                />
                <button
                  onClick={() => {
                    if (!armed) return;
                    setResetting(true);
                    void resetGame();
                  }}
                  disabled={!armed}
                  className="px-btn"
                  style={armed ? { background: "var(--danger)", color: "var(--light)" } : undefined}
                >
                  Reset everything
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
