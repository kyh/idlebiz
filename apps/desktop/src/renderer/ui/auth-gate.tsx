import { useEffect, useState } from "react";
import { setAuthed, setModalOpen } from "@/renderer/state/store";
import type { AuthFlowEvent } from "@/shared/ipc-registry";

/** Shown when an existing company has no working coding CLI (new machine,
 *  logged-out CLI). Same flow as onboarding's auth step, minus the ceremony. */
export function AuthGate() {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  useEffect(() => {
    const bridge = window.appBridge;
    if (!bridge) return;
    const off = bridge.onAuthEvent((e: AuthFlowEvent) => {
      if (e.type === "url") setLines((l) => [...l.slice(-3), `Browser opened: ${e.url}`]);
      else if (e.type === "progress") setLines((l) => [...l.slice(-3), e.message]);
      else if (e.type === "done") {
        setBusy(false);
        setAuthed(true);
      } else if (e.type === "error") {
        setBusy(false);
        setLines((l) => [...l, `Hmm — ${e.message}`]);
      }
    });
    return off;
  }, []);

  const start = () => {
    setBusy(true);
    setLines([]);
    void window.appBridge?.startLogin();
  };

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#10121b]/90 p-6">
      <div className="px-battle w-full max-w-lg p-4">
        <div className="text-[14px] leading-relaxed text-[var(--text)]">
          Your team can't work — no signed-in coding CLI (Claude Code or Codex) was found. Set one
          up to get the office moving again.
        </div>
        {lines.length > 0 ? (
          <div className="px-inset mt-2 max-h-20 overflow-y-auto whitespace-pre-line p-2 text-[11px] text-[var(--text-dim)]">
            {lines.join("\n")}
          </div>
        ) : null}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="px-btn-accent px-btn text-[13px]"
          >
            {busy ? "Setting up…" : "Set up workforce"}
          </button>
        </div>
      </div>
    </div>
  );
}
