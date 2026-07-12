import { useEffect, useState } from "react";
import { useStore, setModalOpen, resetGame, refresh } from "@/renderer/state/store";

/** Game settings. Mostly the danger zone: demolish the office and start over. */
export function Settings({ onClose }: { onClose: () => void }) {
  const { company } = useStore();
  const [confirm, setConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const [cap, setCap] = useState<string | null>(null);

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  if (!company) return null;
  const armed = confirm.trim() === company.name;
  const capValue = cap ?? String(company.maxAgents);

  const saveCap = async () => {
    const n = Number(capValue);
    const bridge = window.appBridge;
    if (!bridge || !Number.isFinite(n) || n < 1) return;
    await bridge.setMaxAgents({ companyId: company.id, maxAgents: Math.round(n) });
    await refresh();
    setCap(null);
  };

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className="px-window flex w-full max-w-xl flex-col">
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div className="text-[16px]">Settings</div>
          <button type="button" onClick={onClose} className="px-btn" disabled={resetting}>
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
              Team size cap
            </div>
            <div className="mt-1 text-[12px] text-[var(--text-dim)]">
              The team lead hires and releases on their own — this is the hard ceiling.
            </div>
            <div className="mt-2 flex gap-2">
              <input
                aria-label="Team size cap"
                value={capValue}
                onChange={(e) => setCap(e.target.value)}
                inputMode="numeric"
                className="px-field w-20 text-[13px]"
              />
              <button
                type="button"
                onClick={() => void saveCap()}
                disabled={cap === null || Number(capValue) === company.maxAgents}
                className="px-btn"
              >
                Save
              </button>
            </div>
          </div>

          <div className="px-inset p-3 text-[13px] text-[var(--text)]">
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
              Controls
            </div>
            <div className="mt-1 text-[12px] text-[var(--text-dim)]">
              WASD / arrows to move · walk up to someone and press E
            </div>
            <div className="mt-1 text-[12px] text-[var(--text-dim)]">
              Closing this window keeps the office running — the 💼 in the menu bar shows status and
              is where you quit.
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
              created, plus stored secrets and connections. The game restarts from scratch. There is
              no undo.
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
                  type="button"
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
