import { useCallback, useEffect, useState } from "react";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { bridge } from "@/renderer/bridge";
import { refresh } from "@/renderer/state/store";
import { useModal } from "@/renderer/ui/modal";
import { Portrait } from "@/renderer/ui/portrait";
import { BUSINESS_TYPES, DEFAULT_FOUNDER_SEED, businessTypeById } from "@/shared/domain";
import type { Budget, BusinessTypeId } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
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

/** The coding CLI the workforce runs on, as far as the probe and the login flow know. */
type Auth =
  | { phase: "checking" }
  | { phase: "signed-out" }
  | { phase: "logging-in"; lines: readonly string[] }
  | { phase: "login-failed"; lines: readonly string[] }
  | { phase: "signed-in"; lines: readonly string[] };
const linesOf = (a: Auth): readonly string[] => ("lines" in a ? a.lines : []);
/** The last few lines the login flow said, plus this one — the box shows four. */
const withLine = (a: Auth, line: string): readonly string[] => [...linesOf(a).slice(-3), line];

/** The founding team, from the pitch to the offer letters. */
type Team =
  | { kind: "uncast" }
  | { kind: "casting" }
  | { kind: "failed"; message: string }
  | { kind: "cast"; hires: HireProposal[] };

/** null is the explicit "no ceiling" choice, not an absent one. */
const CAP_OPTIONS: readonly (number | null)[] = [5, 20, 50, null];
const DEFAULT_CAP = 20;

function Narrator({ text }: { text: string }) {
  const { shown, done, skip } = useTypewriter(text);
  return (
    <button
      type="button"
      className="min-h-[44px] w-full cursor-pointer border-0 bg-transparent p-0 text-left text-sm leading-relaxed text-fg"
      onClick={skip}
    >
      {shown}
      {!done ? <span className="px-live-dot">▌</span> : null}
    </button>
  );
}

function Title() {
  return (
    <div className="mt-10 text-center">
      <div className="text-6xl text-[#f5f3ea]" style={{ textShadow: "4px 4px 0 #1d2136" }}>
        IDLEBIZ
      </div>
      <div className="mt-2 text-xs tracking-wide text-[#8a90ab]">a startup that runs itself</div>
    </div>
  );
}

function LookPicker({
  choices,
  look,
  onPick,
}: {
  choices: FounderChoice[];
  look: number;
  onPick: (i: number) => void;
}) {
  return (
    <div className="grid grid-cols-6 gap-3">
      {choices.map((ch, i) => (
        <button
          type="button"
          key={ch.seed}
          onClick={() => onPick(i)}
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
  );
}

function HiresGrid({ hires }: { hires: HireProposal[] }) {
  return (
    <div className="px-window grid max-h-[46vh] w-full grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
      {hires.map((h) => (
        <div key={h.spriteSeed} className="px-inset flex items-start gap-2 p-2 text-left">
          <Portrait seed={h.spriteSeed} size="sm" />
          <span>
            <span className="block text-sm text-fg">
              {h.name} · <span className="text-accent-lo">{h.title}</span>
            </span>
            <span className="block text-xs text-fg-dim">{h.blurb}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function AuthStep({ auth, onLogin }: { auth: Auth; onLogin: () => void }) {
  const lines = linesOf(auth);
  return (
    <div className="flex w-full flex-col gap-2">
      {lines.length > 0 ? (
        <div className="px-inset max-h-20 overflow-y-auto whitespace-pre-line p-2 text-xs text-fg-dim">
          {lines.join("\n")}
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
          onClick={onLogin}
          disabled={auth.phase === "logging-in"}
          className="px-btn-accent px-btn ml-auto"
        >
          {auth.phase === "logging-in"
            ? "Setting up…"
            : auth.phase === "login-failed"
              ? "Try again"
              : "Set up workforce"}
        </button>
      </div>
    </div>
  );
}

export function PokeOnboarding() {
  const [step, setStep] = useState<Step>("intro");
  const [auth, setAuth] = useState<Auth>({ phase: "checking" });
  const [founderName, setFounderName] = useState("");
  const [choices, setChoices] = useState<FounderChoice[]>([]);
  const [look, setLook] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [biz, setBiz] = useState<BusinessTypeId | null>(null);
  const [pitch, setPitch] = useState("");
  const [team, setTeam] = useState<Team>({ kind: "uncast" });
  const [capUsd, setCapUsd] = useState<number | null>(DEFAULT_CAP);
  const [error, setError] = useState<string | null>(null);

  const hires = team.kind === "cast" ? team.hires : null;
  const budget: Budget = capUsd === null ? { mode: "infinite" } : { mode: "capped", capUsd };

  useModal();

  useEffect(() => {
    void bridge()
      .hasAuth()
      .then((r) => setAuth(r.ok ? { phase: "signed-in", lines: [] } : { phase: "signed-out" }));
    void bridge()
      .getFounderChoices()
      .then(setChoices)
      .catch(() => setChoices([]));
  }, []);

  // stream auth flow events into the dialog
  useEffect(() => {
    const off = bridge().onAuthEvent((e: AuthFlowEvent) => {
      if (e.type === "url") {
        const said = "Your browser opened — authorize there, then come back.";
        setAuth((a) => ({ phase: "logging-in", lines: withLine(a, said) }));
      } else if (e.type === "progress") {
        setAuth((a) => ({ phase: "logging-in", lines: withLine(a, e.message) }));
      } else if (e.type === "done") {
        setAuth((a) => ({ phase: "signed-in", lines: withLine(a, "Connected ✓") }));
        window.setTimeout(() => setStep("founder"), 700);
      } else if (e.type === "error") {
        setAuth((a) => ({ phase: "login-failed", lines: withLine(a, `Hmm — ${e.message}`) }));
      }
    });
    return off;
  }, []);

  const login = () => {
    setAuth({ phase: "logging-in", lines: [] });
    void bridge().startLogin();
  };

  /** Ask a real CLI to cast a founding team for this pitch. Costs money. */
  const castTeam = useCallback(() => {
    setError(null);
    setTeam({ kind: "casting" });
    setStep("team");
    void bridge()
      .generateHires({
        companyName: companyName.trim(),
        mission: pitch.trim(),
        businessType: biz ?? "custom",
      })
      .then((h) => {
        setTeam({ kind: "cast", hires: h });
        return null;
      })
      .catch((cause) => setTeam({ kind: "failed", message: errorMessage(cause) }));
  }, [companyName, pitch, biz]);

  const next = useCallback(() => {
    setError(null);
    // the CLI probe has to land first — routing before it would send a
    // signed-in founder to the login screen
    if (step === "intro") {
      if (auth.phase !== "checking") setStep(auth.phase === "signed-in" ? "founder" : "auth");
    } else if (step === "founder" && founderName.trim()) setStep("look");
    else if (step === "look") setStep("company");
    else if (step === "company" && companyName.trim()) setStep("biztype");
    else if (step === "biztype" && biz !== null) setStep("pitch");
    else if (step === "pitch" && pitch.trim()) castTeam();
    else if (step === "team" && hires !== null && hires.length > 0) setStep("budget");
  }, [step, auth.phase, founderName, companyName, biz, pitch, hires, castTeam]);

  const back = useCallback(() => {
    const prev = backStep(step);
    if (prev !== null) {
      setError(null);
      setStep(prev);
    }
  }, [step]);

  const finalize = async () => {
    if (!hires || hires.length === 0 || step === "finalize") return;
    setError(null);
    setStep("finalize");
    try {
      await bridge().foundCompany({
        name: companyName.trim(),
        mission: pitch.trim(),
        businessType: biz ?? "custom",
        founderName: founderName.trim(),
        founderSpriteSeed: choices[look]?.seed ?? DEFAULT_FOUNDER_SEED,
        budget,
        hires,
      });
      await refresh();
      window.dispatchEvent(new CustomEvent("idlebiz:onboarded"));
    } catch (e) {
      setError(errorMessage(e));
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
      team.kind === "cast"
        ? "Your founding team, cast for this exact pitch. From here the team lead grows or shrinks the roster on their own — you steer with the budget."
        : team.kind === "failed"
          ? "The hiring agency didn't come back. Want me to run the search again?"
          : "Putting out the job posting… reviewing resumes…",
    budget:
      "Last thing, and it's the important one. Your employees think with real AI, and that bills to your account for real. Set the ceiling — they down tools when they hit it, and you can move it any time.",
    finalize: "Signing the lease… assembling desks… your office is ready!",
  } satisfies Record<Step, string>;
  const problem = error ?? (team.kind === "failed" ? team.message : null);

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex flex-col items-center justify-between bg-[#10121b] p-6">
      <Title />

      <div className="flex w-full max-w-2xl flex-1 items-center justify-center py-4">
        {step === "look" && choices.length > 0 ? (
          <LookPicker choices={choices} look={look} onPick={setLook} />
        ) : null}
        {(step === "team" || step === "budget") && hires ? <HiresGrid hires={hires} /> : null}
        {step === "team" && team.kind === "casting" ? (
          <div className="px-live-dot text-4xl">📋</div>
        ) : null}
      </div>

      <div className="px-battle w-full max-w-2xl p-4">
        <Narrator text={narration[step]} />
        {problem ? <div className="mt-1 text-xs text-danger">{problem}</div> : null}

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
              disabled={auth.phase === "checking"}
              className="px-btn-accent px-btn ml-auto"
            >
              {auth.phase === "checking" ? "Checking your CLI…" : "▶ Let's go"}
            </button>
          ) : null}

          {step === "auth" ? <AuthStep auth={auth} onLogin={login} /> : null}

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

          {step === "team" && team.kind === "cast" ? (
            <button type="button" onClick={next} className="px-btn-accent px-btn ml-auto">
              Sign them →
            </button>
          ) : null}

          {step === "team" && team.kind === "failed" ? (
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
                {CAP_OPTIONS.map((usd) => (
                  <button
                    type="button"
                    key={usd ?? "uncapped"}
                    onClick={() => setCapUsd(usd)}
                    data-sel={capUsd === usd}
                    className="px-opt"
                    title={
                      usd === null ? "No ceiling — the office spends whatever it needs" : undefined
                    }
                  >
                    {usd === null ? "No cap" : `$${usd}`}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-fg-dim">
                  {capUsd === null
                    ? "⚠ Uncapped. The office will keep spending while it works."
                    : `They stop taking on new work at $${capUsd} — whatever is already running still finishes. Change it any time from the budget panel.`}
                </span>
                <button
                  type="button"
                  onClick={() => void finalize()}
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
