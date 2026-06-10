import { useEffect, useState } from "react";
import { useStore, hireEmployee, getPortrait, setModalOpen } from "@/renderer/state/store";
import type { HireProposal } from "@/shared/ipc-registry";
import { HIRE_COST } from "@/shared/domain";

/** In-game recruiting: candidates are LLM-cast for THIS company, same as onboarding. */
export function Hiring({ onClose }: { onClose: () => void }) {
  const { company, employees } = useStore();
  const [candidates, setCandidates] = useState<HireProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  useEffect(() => {
    if (!company) return;
    let alive = true;
    const bridge = window.appBridge;
    if (!bridge) return;
    void bridge
      .generateHires({ companyName: company.name, mission: company.mission })
      .then((c) => alive && setCandidates(c))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [company]);

  if (!company) return null;

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className="px-window flex max-h-[88vh] w-full max-w-4xl flex-col">
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div>
            <div className="text-[16px]">Recruiting</div>
            <div className="text-[11px] text-[#c4c9dd]">
              {employees.length} on the team · ${HIRE_COST} per hire · ${Math.floor(company.cash)} in the bank
            </div>
          </div>
          <button onClick={onClose} className="px-btn text-[13px]">
            Done
          </button>
        </div>

        {candidates === null && !error ? (
          <div className="flex flex-1 items-center justify-center p-10 text-[13px] text-[var(--text-dim)]">
            <span className="px-live-dot">Reviewing applications…</span>
          </div>
        ) : null}
        {error ? <div className="p-6 text-[12px] text-[var(--danger)]">{error}</div> : null}

        {candidates ? (
          <div className="px-scroll grid grid-cols-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">
            {candidates.map((c) => (
              <CandidateCard key={c.spriteSeed} c={c} canAfford={company.cash >= HIRE_COST} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CandidateCard({ c, canAfford }: { c: HireProposal; canAfford: boolean }) {
  const [portrait, setPortrait] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "hiring" | "hired" | "failed">("idle");

  useEffect(() => {
    let alive = true;
    void getPortrait(c.spriteSeed).then((u) => alive && setPortrait(u));
    return () => {
      alive = false;
    };
  }, [c.spriteSeed]);

  const hire = async () => {
    setState("hiring");
    try {
      const emp = await hireEmployee({ name: c.name, role: c.role, title: c.title, persona: c.persona, spriteSeed: c.spriteSeed });
      setState(emp ? "hired" : "failed");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="px-inset flex flex-col p-3">
      <div className="flex items-center gap-3">
        {portrait ? (
          <img src={portrait} alt={c.name} className="h-16 w-16 [image-rendering:pixelated]" style={{ border: "2px solid var(--ink)", background: "#cfd6ea" }} />
        ) : (
          <div className="h-16 w-16" style={{ border: "2px solid var(--ink)", background: "#cfd6ea" }} />
        )}
        <div>
          <div className="text-[14px] text-[var(--text)]">{c.name}</div>
          <div className="text-[11px] text-[var(--accent-lo)]">{c.title}</div>
          <div className="text-[10px] text-[var(--text-dim)]">{c.blurb}</div>
        </div>
      </div>
      <p className="mt-2 flex-1 text-[12px] leading-relaxed text-[#54586c]">{c.persona}</p>
      <button
        onClick={() => void hire()}
        disabled={state !== "idle" || !canAfford}
        className={(state === "hired" ? "px-btn" : "px-btn-accent px-btn") + " mt-3 text-[13px]"}
        style={state === "hired" ? { background: "var(--ok)", color: "#0e2a16" } : undefined}
      >
        {state === "hired" ? "✓ Hired" : state === "hiring" ? "Hiring…" : state === "failed" ? "Couldn't hire" : canAfford ? `Hire ($${HIRE_COST})` : "Not enough cash"}
      </button>
    </div>
  );
}
