import { useState } from "react";
import { useStore, resetGame, setMaxAgents } from "@/renderer/state/store";
import { Modal } from "@/renderer/ui/modal";
import { SaveIssues } from "@/renderer/ui/save-issues";

/** Game settings. Mostly the danger zone: demolish the office and start over. */
export function Settings({ onClose }: { onClose: () => void }) {
  const company = useStore((s) => s.company);
  const saveIssues = useStore((s) => s.saveIssues);
  const [confirm, setConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const [cap, setCap] = useState<string | null>(null);

  if (!company) return null;
  const armed = confirm.trim() === company.name;
  const capValue = cap ?? String(company.maxAgents);

  const saveCap = async () => {
    const n = Number(capValue);
    if (!Number.isFinite(n) || n < 1) return;
    await setMaxAgents(Math.round(n));
    setCap(null);
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="space-y-4">
        <div className="px-inset p-3 text-sm text-fg">
          <div className="text-xs uppercase tracking-wide text-fg-dim">Company</div>
          <div className="mt-1">{company.name}</div>
          <div className="text-xs text-fg-dim">{company.mission}</div>
          <div className="mt-1 truncate text-xs text-fg-dim">{company.workspaceDir}</div>
        </div>

        {saveIssues.length > 0 ? (
          <div className="px-inset p-3 text-sm text-fg">
            <div className="text-xs uppercase tracking-wide text-danger">Skipped at boot</div>
            <div className="mt-1 text-xs text-fg-dim">
              These files under ~/.idlebiz did not parse and were left out. Fix them and relaunch.
            </div>
            <div className="mt-2">
              <SaveIssues issues={saveIssues} />
            </div>
          </div>
        ) : null}

        <div className="px-inset p-3 text-sm text-fg">
          <div className="text-xs uppercase tracking-wide text-fg-dim">Team size cap</div>
          <div className="mt-1 text-xs text-fg-dim">
            The team lead hires and releases on their own — this is the hard ceiling.
          </div>
          <div className="mt-2 flex gap-2">
            <input
              aria-label="Team size cap"
              value={capValue}
              onChange={(e) => setCap(e.target.value)}
              inputMode="numeric"
              className="px-field w-20"
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

        <div className="px-inset p-3 text-sm text-fg">
          <div className="text-xs uppercase tracking-wide text-fg-dim">Controls</div>
          <div className="mt-1 text-xs text-fg-dim">
            WASD / arrows to move · walk up to someone and press E
          </div>
          <div className="mt-1 text-xs text-fg-dim">
            Closing this window keeps the office running — the 💼 in the menu bar shows status and
            is where you quit.
          </div>
        </div>

        <div className="px-inset p-3 text-sm text-fg">
          <div className="text-xs uppercase tracking-wide text-fg-dim">Tools</div>
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
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--danger)" }}>
            Danger zone
          </div>
          <div className="mt-1 text-sm leading-snug text-fg">
            Reset demolishes the office: every employee, task, and workspace file your team created,
            plus stored secrets and connections. The game restarts from scratch. There is no undo.
          </div>
          {resetting ? (
            <div className="px-live-dot mt-3 text-sm" style={{ color: "var(--danger)" }}>
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
    </Modal>
  );
}
