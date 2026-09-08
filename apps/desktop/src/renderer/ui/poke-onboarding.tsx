import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useAuthFlow } from "@/renderer/hooks/use-auth-flow";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { bridge } from "@/renderer/bridge";
import { refresh } from "@/renderer/state/store";
import { AuthStep } from "@/renderer/ui/auth-step";
import { useModal } from "@/renderer/ui/modal";
import {
  Building,
  BudgetMeter,
  Emote,
  FLOORS,
  FounderSprite,
  NightSky,
  TeamParade,
} from "@/renderer/ui/onboarding-stage";
import { BUSINESS_TYPES, DEFAULT_FOUNDER_SEED, businessTypeById } from "@/shared/domain";
import type { Budget, BusinessTypeId } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import type { FounderChoice, HireProposal } from "@/shared/ipc-registry";

const STEP_ORDER = [
  "intro",
  "auth",
  "founder",
  "look",
  "company",
  "biztype",
  "pitch",
  "team",
  "budget",
  "finalize",
] as const;
type Step = (typeof STEP_ORDER)[number];

/** The steps that each light a floor once answered — one per floor of the building. */
const FLOOR_STEPS: readonly Step[] = [
  "founder",
  "look",
  "company",
  "biztype",
  "pitch",
  "team",
  "budget",
];
const litFloors = (step: Step): number =>
  step === "finalize"
    ? FLOORS
    : FLOOR_STEPS.filter((s) => STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf(step)).length;

/** Where the founder stands on the street, per step: from the left edge to the door. Absent before they have a look. */
const FOUNDER_AT = new Map<Step, number>([
  ["look", 18],
  ["company", 30],
  ["biztype", 42],
  ["pitch", 54],
  ["team", 62],
  ["budget", 70],
  ["finalize", 83],
]);

/** Where "← back" goes, or null where it doesn't go anywhere. Only the cheap,
 *  reversible steps rewind: casting the team spends a real CLI call, and past
 *  that the office is on disk. */
const backStep = (step: Step): Step | null => {
  switch (step) {
    case "look": {
      return "founder";
    }
    case "company": {
      return "look";
    }
    case "biztype": {
      return "company";
    }
    case "pitch": {
      return "biztype";
    }
    default: {
      return null;
    }
  }
};

type Team =
  | { kind: "uncast" }
  | { kind: "casting" }
  | { kind: "failed"; message: string }
  | { kind: "cast"; hires: HireProposal[] };

/** null is the explicit "no ceiling" choice, not an absent one. */
const CAP_OPTIONS: readonly (number | null)[] = [5, 20, 50, null];
const DEFAULT_CAP = 20;

/** How long the battle-start flash plays before the office is allowed to show. */
const FLASH_MS = 700;

const Narrator = ({ text }: { text: string }) => {
  const { shown, done, skip } = useTypewriter(text);
  return (
    <button
      type="button"
      className="min-h-[44px] w-full cursor-pointer border-0 bg-transparent p-0 text-left text-sm leading-relaxed text-fg"
      onClick={skip}
    >
      {shown}
      {done ? (
        <span className="px-more ml-1 text-accent-lo">▼</span>
      ) : (
        <span className="px-live-dot">▌</span>
      )}
    </button>
  );
};

const Title = ({ pressStart }: { pressStart: boolean }) => (
  <div className="mt-8 text-center">
    <div className="ob-title">IDLEBIZ</div>
    <div className="mt-4 text-xs tracking-wide text-[#8a90ab]">a startup that runs itself</div>
    <div className={pressStart ? "px-blink mt-3 text-xs text-light" : "mt-3 text-xs opacity-0"}>
      ▶ press Enter
    </div>
  </div>
);

const LookPicker = ({
  choices,
  look,
  onPick,
}: {
  choices: FounderChoice[];
  look: number;
  onPick: (i: number) => void;
}) => (
  <div className="grid grid-cols-6 gap-3">
    {choices.map((ch, i) => (
      <button
        type="button"
        key={ch.seed}
        onClick={() => onPick(i)}
        className="p-1"
        style={{
          background: look === i ? "#2a3550" : "#1a1e2e",
          border: look === i ? "3px solid var(--accent)" : "3px solid var(--ink)",
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

const TextStep = ({
  value,
  onChange,
  placeholder,
  cta,
  onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  cta: string;
  onNext: () => void;
}) => (
  <>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="px-field flex-1"
      autoFocus
    />
    <button
      type="button"
      onClick={onNext}
      disabled={!value.trim()}
      className="px-btn-accent px-btn"
    >
      {cta}
    </button>
  </>
);

const teamNarration = (team: Team): string => {
  switch (team.kind) {
    case "cast": {
      return "Your founding team, cast for this exact pitch. From here the team lead grows or shrinks the roster on their own — you steer with the budget.";
    }
    case "failed": {
      return "The hiring agency didn't come back. Want me to run the search again?";
    }
    default: {
      return "Putting out the job posting… reviewing resumes…";
    }
  }
};

const narrationFor = (companyName: string, team: Team): Record<Step, string> => ({
  auth: "First things first: your employees run on your own coding CLI — Claude Code or Codex. No CLI, no workforce. I'll check what's installed and set it up.",
  biztype: `What kind of company is ${companyName || "this"} going to be?`,
  budget:
    "Last thing, and it's the important one. Your employees think with real AI, and that bills to your account for real. Set the ceiling — they down tools when they hit it, and you can move it any time.",
  company: "Now the fun part. What's your company called?",
  finalize: "Signing the lease… assembling desks… your office is ready!",
  founder: "Let's get you on payroll. What's your name, founder?",
  intro:
    "Welcome to IDLEBIZ! You're about to found a startup staffed by real AI employees — they write real code and real docs in a real folder on your computer.",
  look: "Pick your look. That's you out on the street — you'll look the same around the office.",
  pitch: `What is ${companyName || "your company"} building? Be specific — your team will literally start working on this.`,
  team: teamNarration(team),
});

const loadFounderChoices = async (): Promise<FounderChoice[]> => {
  try {
    return await bridge().getFounderChoices();
  } catch {
    return [];
  }
};

export const PokeOnboarding = () => {
  const [step, setStep] = useState<Step>("intro");
  const [founderName, setFounderName] = useState("");
  const [choices, setChoices] = useState<FounderChoice[]>([]);
  const [look, setLook] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [biz, setBiz] = useState<BusinessTypeId | null>(null);
  const [pitch, setPitch] = useState("");
  const [team, setTeam] = useState<Team>({ kind: "uncast" });
  const [capUsd, setCapUsd] = useState<number | null>(DEFAULT_CAP);
  const [failure, setFailure] = useState<string | null>(null);

  const hires = team.kind === "cast" ? team.hires : null;
  const budget: Budget = capUsd === null ? { mode: "infinite" } : { capUsd, mode: "capped" };

  useModal();

  useEffect(() => {
    const load = async () => {
      setChoices(await loadFounderChoices());
    };
    void load();
  }, []);

  const { auth, login } = useAuthFlow({
    // a beat on "Connected ✓" before the founder's own step
    onSignedIn: () => window.setTimeout(() => setStep("founder"), 700),
    probe: true,
  });

  /** Ask a real CLI to cast a founding team for this pitch. Costs money. */
  const castTeam = useCallback(() => {
    setFailure(null);
    setTeam({ kind: "casting" });
    setStep("team");
    const cast = async () => {
      try {
        const h = await bridge().generateHires({
          businessType: biz ?? "custom",
          companyName: companyName.trim(),
          mission: pitch.trim(),
        });
        setTeam({ hires: h, kind: "cast" });
      } catch (error) {
        setTeam({ kind: "failed", message: errorMessage(error) });
      }
    };
    void cast();
  }, [companyName, pitch, biz]);

  const next = useCallback(() => {
    setFailure(null);
    // the CLI probe has to land first — routing before it would send a
    // signed-in founder to the login screen
    if (step === "intro") {
      if (auth.phase !== "checking") {
        setStep(auth.phase === "signed-in" ? "founder" : "auth");
      }
    } else if (step === "founder" && founderName.trim()) {
      setStep("look");
    } else if (step === "look") {
      setStep("company");
    } else if (step === "company" && companyName.trim()) {
      setStep("biztype");
    } else if (step === "biztype" && biz !== null) {
      setStep("pitch");
    } else if (step === "pitch" && pitch.trim()) {
      castTeam();
    } else if (step === "team" && hires !== null && hires.length > 0) {
      setStep("budget");
    }
  }, [step, auth.phase, founderName, companyName, biz, pitch, hires, castTeam]);

  const back = useCallback(() => {
    const prev = step === "team" && team.kind === "failed" ? "pitch" : backStep(step);
    if (prev !== null) {
      setFailure(null);
      if (step === "team") {
        setTeam({ kind: "uncast" });
      }
      setStep(prev);
    }
  }, [step, team.kind]);

  const finalize = async () => {
    if (!hires || hires.length === 0 || step === "finalize") {
      return;
    }
    setFailure(null);
    setStep("finalize");
    try {
      // the flash plays over the night; only then does the office get to show
      await Promise.all([
        bridge().foundCompany({
          budget,
          businessType: biz ?? "custom",
          founderName: founderName.trim(),
          founderSpriteSeed: choices[look]?.seed ?? DEFAULT_FOUNDER_SEED,
          hires,
          mission: pitch.trim(),
          name: companyName.trim(),
        }),
        // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, FLASH_MS);
        }),
      ]);
      await refresh();
      window.dispatchEvent(new CustomEvent("idlebiz:onboarded"));
    } catch (error) {
      setFailure(errorMessage(error));
      setStep("budget");
    }
  };

  // Enter advances input steps; Escape rewinds the reversible ones; the arrow
  // keys walk the looks, the way a starter is picked
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const tag = document.activeElement?.tagName;
    if (e.key === "Escape") {
      back();
      return;
    }
    if (step === "look" && choices.length > 0) {
      if (e.key === "ArrowRight") {
        setLook((i) => (i + 1) % choices.length);
      } else if (e.key === "ArrowLeft") {
        setLook((i) => (i + choices.length - 1) % choices.length);
      }
    }
    if (e.key !== "Enter" || tag === "TEXTAREA") {
      return;
    }
    next();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const narration = narrationFor(companyName.trim(), team);
  const problem = failure ?? (team.kind === "failed" ? team.message : null);

  const seed = choices[look]?.seed ?? DEFAULT_FOUNDER_SEED;
  const at = FOUNDER_AT.get(step) ?? null;

  const renderActions = () => {
    switch (step) {
      case "intro": {
        return (
          <button
            type="button"
            onClick={next}
            disabled={auth.phase === "checking"}
            className="px-btn-accent px-btn ml-auto"
          >
            {auth.phase === "checking" ? "Checking your CLI…" : "▶ Let's go"}
          </button>
        );
      }
      case "auth": {
        return (
          <AuthStep
            auth={auth}
            onLogin={login}
            aside={
              <button
                type="button"
                onClick={() => {
                  void bridge().resetGame();
                }}
                className="px-link px-link-danger"
                title="Delete saved companies and restart"
              >
                ↺ start over
              </button>
            }
          />
        );
      }
      case "founder": {
        return (
          <TextStep
            value={founderName}
            onChange={setFounderName}
            placeholder="Ada"
            cta="That's me"
            onNext={next}
          />
        );
      }
      case "look": {
        return (
          <button type="button" onClick={next} className="px-btn-accent px-btn ml-auto">
            Looking sharp →
          </button>
        );
      }
      case "company": {
        return (
          <TextStep
            value={companyName}
            onChange={setCompanyName}
            placeholder="Acme AI"
            cta="Register it"
            onNext={next}
          />
        );
      }
      case "biztype": {
        return (
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
                  {b.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={next}
              disabled={biz === null}
              className="px-btn-accent px-btn ml-auto"
            >
              That&apos;s the plan →
            </button>
          </div>
        );
      }
      case "pitch": {
        return (
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
              That&apos;s the vision
            </button>
          </div>
        );
      }
      case "team": {
        switch (team.kind) {
          case "cast": {
            return (
              <button type="button" onClick={next} className="px-btn-accent px-btn ml-auto">
                Sign them →
              </button>
            );
          }
          case "failed": {
            return (
              <>
                <button type="button" onClick={back} className="px-link">
                  ← rewrite the pitch
                </button>
                <button type="button" onClick={castTeam} className="px-btn-accent px-btn ml-auto">
                  Search again
                </button>
              </>
            );
          }
          default: {
            return null;
          }
        }
      }
      case "budget": {
        return (
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
                onClick={() => {
                  void finalize();
                }}
                className="px-btn-accent px-btn ml-auto"
              >
                Open the office →
              </button>
            </div>
          </div>
        );
      }
      default: {
        return null;
      }
    }
  };

  return (
    <div className="ob-scene pointer-events-auto absolute inset-0 z-40 overflow-hidden">
      <NightSky />
      <div className="relative z-10 flex h-full flex-col items-center justify-between p-6">
        <Title pressStart={step === "intro"} />

        <div className="ob-stage">
          <div className="ob-stage-left flex justify-center">
            {step === "look" && choices.length > 0 ? (
              <LookPicker choices={choices} look={look} onPick={setLook} />
            ) : null}
            {step === "team" && hires ? <TeamParade hires={hires} /> : null}
            {step === "budget" ? <BudgetMeter capUsd={capUsd} /> : null}
          </div>
          <div className="relative">
            <Building lit={litFloors(step)} open={step === "finalize"} />
          </div>
          {step === "team" && team.kind === "casting" ? (
            <Emote frame={1} className="ob-emote-door" />
          ) : null}
          <div className="ob-street" />
          <div className="ob-ground" />
          {at === null ? null : <FounderSprite seed={seed} at={at} />}
        </div>

        <div className="px-battle w-full max-w-2xl p-4">
          <Narrator text={narration[step]} />
          {problem ? <div className="mt-1 text-xs text-danger">{problem}</div> : null}

          {backStep(step) === null ? null : (
            <button type="button" onClick={back} className="px-link mt-2" title="Esc">
              ← back
            </button>
          )}

          <div className="mt-3 flex items-center gap-2">{renderActions()}</div>
        </div>
      </div>
      {step === "finalize" ? <div className="ob-flash" /> : null}
    </div>
  );
};
