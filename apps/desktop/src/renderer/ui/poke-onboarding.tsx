import { useCallback, useEffect, useState } from "react";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { setModalOpen, refresh, getPortrait } from "@/renderer/state/store";
import { BUSINESS_TYPES, businessTypeById } from "@/shared/domain";
import type { Budget, BusinessTypeId } from "@/shared/domain";
import type { AuthFlowEvent, FounderChoice, HireProposal } from "@/shared/ipc-registry";

// ---------------------------------------------------------------------------
// Pokémon-style first-run onboarding: one battle box, a narrator, and a step
// machine — auth → founder → look → company → biztype → pitch → team → budget
// → office.
// ---------------------------------------------------------------------------

type Step =
  | "intro"
  | "auth"
  | "founder"
  | "look"
  | "company"
  | "biztype"
  | "pitch"
  | "team"
  | "budget"
  | "finalize";

/** Where "← back" goes, or null where it doesn't go anywhere. Only the cheap,
 *  reversible steps rewind: casting the team spends a real CLI call, and past
 *  that the office is on disk. */
function backStep(step: Step): Step | null {
  switch (step) {
    case "look":
      return "founder";
    case "company":
      return "look";
    case "biztype":
      return "company";
    case "pitch":
      return "biztype";
    default:
      return null;
  }
}

const CAP_PRESETS = [5, 20, 50] as const;
const DEFAULT_CAP = 20;

const bridge = () => {
  const b = window.appBridge;
  if (!b) throw new Error("appBridge unavailable");
  return b;
};

function Narrator({ text }: { text: string }) {
  const { shown, done, skip } = useTypewriter(text);
  return (
    <button
      type="button"
      className="min-h-[44px] w-full cursor-pointer border-0 bg-transparent p-0 text-left text-[14px] leading-relaxed text-[var(--text)]"
      onClick={skip}
    >
      {shown}
      {!done ? <span className="px-live-dot">▌</span> : null}
    </button>
  );
}

export function PokeOnboarding() {
  const [step, setStep] = useState<Step>("intro");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [authLines, setAuthLines] = useState<string[]>([]);
  const [authTried, setAuthTried] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [founderName, setFounderName] = useState("");
  const [choices, setChoices] = useState<FounderChoice[]>([]);
  const [look, setLook] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [biz, setBiz] = useState<BusinessTypeId | null>(null);
  const [pitch, setPitch] = useState("");
  const [hires, setHires] = useState<HireProposal[] | null>(null);
  const [capUsd, setCapUsd] = useState<number | null>(DEFAULT_CAP);
  const [error, setError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  // what a previous finalize attempt already committed to disk
  const [built, setBuilt] = useState<{ companyId: string | null; hired: boolean }>({
    companyId: null,
    hired: false,
  });

  const budget: Budget = capUsd === null ? { mode: "infinite" } : { mode: "capped", capUsd };
  // the office exists from the first createCompany, so its budget is settled
  const budgetLocked = built.companyId !== null;

  useEffect(() => {
    setModalOpen(true);
    void bridge()
      .hasAuth()
      .then((r) => setAuthed(r.ok));
    void bridge()
      .getFounderChoices()
      .then(setChoices)
      .catch(() => setChoices([]));
    return () => setModalOpen(false);
  }, []);

  // stream auth flow events into the dialog
  useEffect(() => {
    const off = bridge().onAuthEvent((e: AuthFlowEvent) => {
      if (e.type === "url") {
        setAuthLines((l) => [...l, "Your browser opened — authorize there, then come back."]);
      } else if (e.type === "progress") setAuthLines((l) => [...l.slice(-3), e.message]);
      else if (e.type === "done") {
        setAuthBusy(false);
        setAuthed(true);
        setAuthLines((l) => [...l, "Connected ✓"]);
        window.setTimeout(() => setStep("founder"), 700);
      } else if (e.type === "error") {
        setAuthBusy(false);
        setAuthLines((l) => [...l, `Hmm — ${e.message}`]);
      }
    });
    return off;
  }, []);

  /** Ask a real CLI to cast a founding team for this pitch. Costs money. */
  const castTeam = useCallback(() => {
    setError(null);
    setHires(null);
    setStep("team");
    void bridge()
      .generateHires({
        companyName: companyName.trim(),
        mission: pitch.trim(),
        businessType: biz ?? "custom",
      })
      .then((h) => {
        setHires(h);
        return null;
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [companyName, pitch, biz]);

  const next = useCallback(() => {
    setError(null);
    // authed is null until the CLI probe lands — routing on it would send a
    // signed-in founder to the login screen
    if (step === "intro") {
      if (authed !== null) setStep(authed ? "founder" : "auth");
    } else if (step === "founder" && founderName.trim()) setStep("look");
    else if (step === "look") setStep("company");
    else if (step === "company" && companyName.trim()) setStep("biztype");
    else if (step === "biztype" && biz !== null) setStep("pitch");
    else if (step === "pitch" && pitch.trim()) castTeam();
    else if (step === "team" && hires !== null && hires.length > 0) setStep("budget");
  }, [step, authed, founderName, companyName, biz, pitch, hires, castTeam]);

  const back = useCallback(() => {
    const prev = backStep(step);
    if (prev !== null) {
      setError(null);
      setStep(prev);
    }
  }, [step]);

  const finalize = async () => {
    if (!hires || hires.length === 0 || finalizing) return;
    setFinalizing(true);
    setError(null);
    setStep("finalize");
    try {
      // each leg is skipped if a previous attempt already landed it: the office
      // is on disk the moment createCompany returns, and hiring twice would
      // double the payroll
      let { companyId, hired } = built;
      if (companyId === null) {
        const co = await bridge().createCompany({
          name: companyName.trim(),
          mission: pitch.trim(),
          businessType: biz ?? "custom",
          founderName: founderName.trim(),
          founderSpriteSeed: choices[look]?.seed ?? "founder-player-001",
          budget,
        });
        companyId = co.id;
        setBuilt({ companyId, hired });
      }
      if (!hired) {
        await bridge().batchHire({ companyId, hires });
        hired = true;
        setBuilt({ companyId, hired });
      }
      await bridge().completeOnboarding({ companyId });
      await refresh();
      window.dispatchEvent(new CustomEvent("idlebiz:onboarded"));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setFinalizing(false);
      setStep("budget");
    }
  };

  // Enter advances input steps; Escape rewinds the reversible ones
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (e.key === "Escape") {
        back();
        return;
      }
      if (e.key !== "Enter" || tag === "TEXTAREA") return;
      next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back]);

  const narration = {
    intro:
      "Welcome to IDLEBIZ! You're about to found a startup staffed by real AI employees — they write real code and real docs in a real folder on your computer.",
    auth: "First things first: your employees run on your own coding CLI — Claude Code or Codex. No CLI, no workforce. I'll check what's installed and set it up.",
    founder: "Let's get you on payroll. What's your name, founder?",
    look: "Pick your look. This is how you'll appear around the office.",
    company: "Now the fun part. What's your company called?",
    biztype: `What kind of company is ${companyName.trim() || "this"} going to be?`,
    pitch: `What is ${companyName.trim() || "your company"} building? Be specific — your team will literally start working on this.`,
    team:
      hires === null
        ? error === null
          ? "Putting out the job posting… reviewing resumes…"
          : "The hiring agency didn't come back. Want me to run the search again?"
        : "Your founding team, cast for this exact pitch. From here the team lead grows or shrinks the roster on their own — you steer with the budget.",
    budget:
      "Last thing, and it's the important one. Your employees think with real AI, and that bills to your account for real. Set the ceiling — they down tools when they hit it, and you can move it any time.",
    finalize: "Signing the lease… assembling desks… your office is ready!",
  } satisfies Record<Step, string>;

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex flex-col items-center justify-between bg-[#10121b] p-6">
      {/* title */}
      <div className="mt-10 text-center">
        <div className="text-6xl text-[#f5f3ea]" style={{ textShadow: "4px 4px 0 #1d2136" }}>
          IDLEBIZ
        </div>
        <div className="mt-2 text-[12px] tracking-wide text-[#8a90ab]">
          a startup that runs itself
        </div>
      </div>

      {/* step content above the battle box */}
      <div className="flex w-full max-w-2xl flex-1 items-center justify-center py-4">
        {step === "look" && choices.length > 0 ? (
          <div className="grid grid-cols-6 gap-3">
            {choices.map((ch, i) => (
              <button
                type="button"
                key={ch.seed}
                onClick={() => setLook(i)}
                className="p-1"
                style={{
                  border: look === i ? "3px solid var(--accent)" : "3px solid var(--ink)",
                  background: look === i ? "#2a3550" : "#1a1e2e",
                  boxShadow: look === i ? "0 0 0 2px var(--accent-hi)" : "none",
                }}
              >
                <img
                  src={ch.portraitDataUrl}
                  alt={`look ${i + 1}`}
                  className="h-14 w-14 [image-rendering:pixelated]"
                />
              </button>
            ))}
          </div>
        ) : null}

        {(step === "team" || step === "budget") && hires ? (
          <div className="px-window grid max-h-[46vh] w-full grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
            {hires.map((h) => (
              <div key={h.spriteSeed} className="px-inset flex items-start gap-2 p-2 text-left">
                <Portrait seed={h.spriteSeed} />
                <span>
                  <span className="block text-[13px] text-[var(--text)]">
                    {h.name} · <span className="text-[var(--accent-lo)]">{h.title}</span>
                  </span>
                  <span className="block text-[10px] text-[var(--text-dim)]">{h.blurb}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {step === "team" && hires === null && !error ? (
          <div className="px-live-dot text-4xl">📋</div>
        ) : null}
      </div>

      {/* the battle box */}
      <div className="px-battle w-full max-w-2xl p-4">
        <Narrator text={narration[step]} />
        {error ? <div className="mt-1 text-[12px] text-[var(--danger)]">{error}</div> : null}

        {backStep(step) !== null ? (
          <button type="button" onClick={back} className="px-link mt-2" title="Esc">
            ← back
          </button>
        ) : null}

        <div className="mt-3 flex items-center gap-2">
          {step === "intro" ? (
            <button
              type="button"
              onClick={next}
              disabled={authed === null}
              className="px-btn-accent px-btn ml-auto"
            >
              {authed === null ? "Checking your CLI…" : "▶ Let's go"}
            </button>
          ) : null}

          {step === "auth" ? (
            <div className="flex w-full flex-col gap-2">
              {authLines.length > 0 ? (
                <div className="px-inset max-h-20 overflow-y-auto whitespace-pre-line p-2 text-[11px] text-[var(--text-dim)]">
                  {authLines.join("\n")}
                </div>
              ) : null}
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => void bridge().resetGame()}
                  className="px-link px-link-danger"
                  title="Wipe everything in ~/.idlebiz and restart"
                >
                  ↺ start over
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthBusy(true);
                    setAuthTried(true);
                    setAuthLines([]);
                    void bridge().startLogin();
                  }}
                  disabled={authBusy}
                  className="px-btn-accent px-btn ml-auto"
                >
                  {authBusy ? "Setting up…" : authTried ? "Try again" : "Set up workforce"}
                </button>
              </div>
            </div>
          ) : null}

          {step === "founder" ? (
            <>
              <input
                value={founderName}
                onChange={(e) => setFounderName(e.target.value)}
                placeholder="Ada"
                className="px-field flex-1"
                autoFocus
              />
              <button
                type="button"
                onClick={next}
                disabled={!founderName.trim()}
                className="px-btn-accent px-btn"
              >
                That's me
              </button>
            </>
          ) : null}

          {step === "look" ? (
            <button type="button" onClick={next} className="px-btn-accent px-btn ml-auto">
              Looking sharp →
            </button>
          ) : null}

          {step === "company" ? (
            <>
              <input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme AI"
                className="px-field flex-1"
                autoFocus
              />
              <button
                type="button"
                onClick={next}
                disabled={!companyName.trim()}
                className="px-btn-accent px-btn"
              >
                Register it
              </button>
            </>
          ) : null}

          {step === "biztype" ? (
            <div className="flex w-full flex-col gap-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {BUSINESS_TYPES.map((b) => (
                  <button
                    type="button"
                    key={b.id}
                    onClick={() => setBiz(b.id)}
                    data-sel={biz === b.id}
                    className="px-opt text-left"
                  >
                    {b.emoji} {b.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={next}
                disabled={biz === null}
                className="px-btn-accent px-btn ml-auto"
              >
                That's the plan →
              </button>
            </div>
          ) : null}

          {step === "pitch" ? (
            <div className="flex w-full flex-col gap-2">
              <textarea
                value={pitch}
                onChange={(e) => setPitch(e.target.value)}
                rows={3}
                placeholder={businessTypeById(biz ?? "custom").pitchPlaceholder}
                className="px-field w-full resize-none"
                autoFocus
              />
              <button
                type="button"
                onClick={next}
                disabled={!pitch.trim()}
                className="px-btn-accent px-btn ml-auto"
              >
                That's the vision
              </button>
            </div>
          ) : null}

          {step === "team" && hires ? (
            <button type="button" onClick={next} className="px-btn-accent px-btn ml-auto">
              Sign them →
            </button>
          ) : null}

          {step === "team" && hires === null && error !== null ? (
            <>
              <button type="button" onClick={back} className="px-link">
                ← rewrite the pitch
              </button>
              <button type="button" onClick={castTeam} className="px-btn-accent px-btn ml-auto">
                Search again
              </button>
            </>
          ) : null}

          {step === "budget" ? (
            <div className="flex w-full flex-col gap-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {CAP_PRESETS.map((usd) => (
                  <button
                    type="button"
                    key={usd}
                    onClick={() => setCapUsd(usd)}
                    disabled={budgetLocked}
                    data-sel={capUsd === usd}
                    className="px-opt"
                  >
                    ${usd}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setCapUsd(null)}
                  disabled={budgetLocked}
                  data-sel={capUsd === null}
                  className="px-opt"
                  title="No ceiling — the office spends whatever it needs"
                >
                  No cap
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--text-dim)]">
                  {capUsd === null
                    ? "⚠ Uncapped. The office will keep spending while it works."
                    : `They stop taking on new work at $${capUsd} — whatever is already running still finishes. Change it any time from the budget panel.`}
                </span>
                <button
                  type="button"
                  onClick={() => void finalize()}
                  disabled={finalizing}
                  className="px-btn-accent px-btn ml-auto"
                >
                  Open the office →
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Portrait({ seed }: { seed: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const u = await getPortrait(seed);
      if (alive) setUrl(u);
    })();
    return () => {
      alive = false;
    };
  }, [seed]);
  return url ? (
    <img
      src={url}
      alt=""
      className="h-12 w-12 shrink-0 [image-rendering:pixelated]"
      style={{ border: "2px solid var(--ink)", background: "#cfd6ea" }}
    />
  ) : (
    <span
      className="h-12 w-12 shrink-0"
      style={{ border: "2px solid var(--ink)", background: "#cfd6ea" }}
    />
  );
}
