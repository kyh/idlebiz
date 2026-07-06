import { useEffect, useState } from "react";
import { setAuthed, setModalOpen } from "@/renderer/state/store";
import type { AuthFlowEvent } from "@/shared/ipc-registry";

/** Shown when an existing company has lost its OpenAI connection (new machine,
 *  revoked token). Same flow as onboarding's auth step, minus the ceremony. */
export function AuthGate() {
  const [lines, setLines] = useState<string[]>([]);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  useEffect(() => {
    const bridge = window.appBridge;
    if (!bridge) return;
    const off = bridge.onAuthEvent((e: AuthFlowEvent) => {
      if (e.type === "url") setUrl(e.url);
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
          Your team can't work — the OpenAI connection is missing. Reconnect to get the office
          moving again.
        </div>
        {lines.length > 0 ? (
          <div className="px-inset mt-2 max-h-20 overflow-y-auto whitespace-pre-line p-2 text-[11px] text-[var(--text-dim)]">
            {lines.join("\n")}
          </div>
        ) : null}
        {url ? (
          <div className="mt-2 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="…or paste the code from the browser"
              className="px-field flex-1 text-[12px]"
            />
            <button
              onClick={() => {
                if (code.trim()) void window.appBridge?.submitAuthCode({ code: code.trim() });
              }}
              className="px-btn text-[12px]"
            >
              Submit
            </button>
          </div>
        ) : null}
        <div className="mt-3 flex justify-end">
          <button onClick={start} disabled={busy} className="px-btn-accent px-btn text-[13px]">
            {busy ? "Waiting for authorization…" : url ? "Try again" : "Connect OpenAI account"}
          </button>
        </div>
      </div>
    </div>
  );
}
