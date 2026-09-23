import { useEffect, useEffectEvent, useState } from "react";
import { getCharacterAssets } from "@/renderer/character-assets";
import { useAsync } from "@/renderer/hooks/use-async";
import { useAuthFlow } from "@/renderer/hooks/use-auth-flow";
import type { Auth } from "@/renderer/hooks/use-auth-flow";
import { useKeyedState } from "@/renderer/hooks/use-keyed-state";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { bridge } from "@/renderer/bridge";
import { officeReady, refresh } from "@/renderer/state/store";
import { AuthStep } from "@/renderer/ui/auth-step";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import { useModal } from "@/renderer/ui/modal";
import {
  BudgetMeter,
  Backdrop,
  FounderSprite,
  Narrator,
  OfficeBackdrop,
  TeamParade,
} from "@/renderer/ui/onboarding-stage";
import { ChoiceMenu } from "@/renderer/ui/choice-menu";
import type { Menu, MenuItem } from "@/renderer/ui/choice-menu";
import { ConfirmLink } from "@/renderer/ui/confirm-link";
import { TypeCursor } from "@/renderer/ui/type-cursor";
import { BUSINESS_TYPES, DEFAULT_FOUNDER_SEED, businessTypeById } from "@/shared/domain";
import type { Budget, BusinessTypeId } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import type { HireProposal } from "@/shared/hire";

const STEP_ORDER = [
  "title",
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

/** Each answer fills one of the founding markers. */
const FOUNDING_STEPS: readonly Step[] = [
  "founder",
  "look",
  "company",
  "biztype",
  "pitch",
  "team",
  "budget",
];
const completedSteps = (step: Step): number =>
  step === "finalize"
    ? FOUNDING_STEPS.length
    : FOUNDING_STEPS.filter((s) => STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf(step)).length;

const STEP_LABELS = {
  auth: "Connect your workforce",
  biztype: "Your business",
  budget: "Your budget",
  company: "Your company",
  finalize: "Open for business",
  founder: "The founder",
  intro: "Meet your first investor",
  look: "Your look",
  pitch: "Your big idea",
  team: "Your founding team",
  title: "IdleBiz",
} satisfies Record<Step, string>;

/** Where "back" goes, or null where it doesn't go anywhere. Only the cheap,
 *  reversible steps rewind: casting the team spends a real CLI call, and past
 *  that the office is on disk. */
const BACK_STEP = {
  auth: null,
  biztype: "company",
  budget: null,
  company: "look",
  finalize: null,
  founder: null,
  intro: null,
  look: "founder",
  pitch: "biztype",
  team: null,
  title: null,
} satisfies Record<Step, Step | null>;

type Team =
  | { kind: "uncast" }
  | { kind: "casting" }
  | { kind: "failed"; message: string }
  | { kind: "cast"; hires: HireProposal[] };

/** The caps on offer; null is the explicit "no ceiling" choice, not an absent one. */
const CAPS: readonly (number | null)[] = [5, 20, 50, null];
const CAP_ITEMS: readonly MenuItem[] = CAPS.map((cap) =>
  cap === null
    ? { hint: "No ceiling — the office spends whatever it needs", label: "No cap" }
    : { label: `$${cap}` },
);
const DEFAULT_CAP_INDEX = 1;

const BIZ_ITEMS: readonly MenuItem[] = BUSINESS_TYPES.map((b) => ({ label: b.label }));
const LOOK_ITEMS: readonly MenuItem[] = [{ label: "That's me" }, { label: "Show me another" }];
const CAST_ITEMS: readonly MenuItem[] = [{ label: "Sign them" }, { label: "Search again" }];
const FAILED_ITEMS: readonly MenuItem[] = [
  { label: "Search again" },
  { label: "Rewrite the pitch" },
];
const OPEN_FAILED_ITEMS: readonly MenuItem[] = [{ label: "Try again" }];

const teamScript = (team: Team): readonly string[] => {
  switch (team.kind) {
    case "cast": {
      return [
        "Boom. Founding team, cast for that exact pitch. I know people.",
        "From here the team lead hires and fires on their own. You steer with the budget.",
      ];
    }
    case "failed": {
      return ["Huh. My recruiter isn't picking up. Want me to try again?"];
    }
    case "uncast":
    case "casting": {
      return ["Hang on, let me text my recruiter…", "…she's reviewing resumes…"];
    }
    // no default
  }
};

/** What Chad says at each step, a page at a time. The step's prompt opens
 *  under the last page. */
const scriptFor = (
  step: Step,
  founderName: string,
  companyName: string,
  team: Team,
): readonly string[] => {
  const you = founderName || "founder";
  const co = companyName || "your company";
  switch (step) {
    case "title": {
      return [];
    }
    case "intro": {
      return [
        "Hey! Welcome to the world of IDLEBIZ!",
        "Chad Runwayson. I write checks. That office down the street? I own the building — and tonight it's yours, every floor of it, if you've got a pitch.",
        "This world runs on employees. They live in your coding CLI — Claude Code or Codex — and they write real code, in a real folder, on your computer. Real burn, too.",
      ];
    }
    case "auth": {
      return [
        "Hm. I don't see a coding CLI signed in on this machine. No CLI, no employees. Let's fix that first.",
      ];
    }
    case "founder": {
      return ["So. Tell me about the founder. What's your name?"];
    }
    case "look": {
      return [`${you}. Love it. And which of these is you?`];
    }
    case "company": {
      return [`Okay ${you}. The company you're founding — what's it called?`];
    }
    case "biztype": {
      return [`${co}. Strong name. What kind of company is ${co} going to be?`];
    }
    case "pitch": {
      return [
        `Now the pitch. What will ${co} build? Be specific — your employees start on it tonight.`,
      ];
    }
    case "team": {
      return teamScript(team);
    }
    case "budget": {
      return [
        "Last thing, and it's the one I care about. Employees think with real AI, and that bills your account for real.",
        "Set the burn ceiling. They down tools when they hit it, and you can move it any time.",
      ];
    }
    case "finalize": {
      return [`${co}! Your very own business legend starts tonight. Here are the keys — go.`];
    }
    // no default
  }
};

/**
 * A script read a page at a time: Enter skips the typing, then turns the page,
 * and only past the last page does it reach the step's prompt. The page is
 * keyed by the script, so a new one starts on page one.
 */
const useScript = (key: string, pages: readonly string[]) => {
  const [page, setPage] = useKeyedState(key, 0);
  const last = page >= pages.length - 1;
  const writer = useTypewriter(pages[page] ?? "");
  const promptOpen = last && writer.done;
  /** Returns true once there is nothing left to read. */
  const advance = (): boolean => {
    if (!writer.done) {
      writer.skip();
      return false;
    }
    if (last) {
      return true;
    }
    setPage(page + 1);
    return false;
  };
  /** Straight to the last page, for players who have heard the speech. */
  const skip = () => setPage(pages.length - 1);
  return { advance, done: writer.done, last, promptOpen, shown: writer.shown, skip };
};

/** The looks on offer, warmed as soon as they are known so browsing them is instant. */
const loadFounderChoices = async (): Promise<string[]> => {
  const seeds = await bridge().getFounderChoices();
  for (const seed of seeds) {
    void getCharacterAssets(seed);
  }
  return seeds;
};

const TitleScreen = ({ onStart }: { onStart: () => void }) => (
  <div className="ob-title-screen">
    <div className="ob-title-art">
      <img className="ob-title-props" src="./onboarding/founding-props.webp" alt="" />
      <img className="ob-title-logo" src="./onboarding/idlebiz-wordmark.webp" alt="IdleBiz" />
    </div>
    <p className="ob-tagline">A little office. A big idea. Your company.</p>
    <button type="button" className="px-btn ob-start" onClick={onStart}>
      Start your company
    </button>
    <span className="ob-start-hint">or press Enter ↵</span>
  </div>
);

const Textbox = ({
  shown,
  done,
  last,
  onAdvance,
  hint,
  problem,
  children,
}: {
  shown: string;
  done: boolean;
  last: boolean;
  onAdvance: () => void;
  hint: string | null;
  problem: string | null;
  children: React.ReactNode;
}) => (
  <div className="ob-box">
    <EmployeeTag name="Chad Runwayson" title="Your first investor" />
    <button type="button" className="ob-box-text" onClick={onAdvance}>
      {shown}
      <TypeCursor done={done} more={!last} />
    </button>
    {children}
    {problem ? <div className="px-hint px-hint-danger">{problem}</div> : null}
    {hint && !problem ? <div className="px-hint">{hint}</div> : null}
  </div>
);

/** What a step asks for once its page is read: a line of text, a pitch, or a sign-in. */
type Prompt =
  | { kind: "text"; value: string; placeholder: string; onChange: (v: string) => void }
  | { kind: "pitch"; value: string; placeholder: string; onChange: (v: string) => void }
  | { kind: "auth" };

const PromptField = ({
  prompt,
  auth,
  onLogin,
}: {
  prompt: Prompt;
  auth: Auth;
  onLogin: () => void;
}) => {
  switch (prompt.kind) {
    case "auth": {
      return (
        <AuthStep
          auth={auth}
          onLogin={onLogin}
          aside={
            <ConfirmLink
              label="↺ start over"
              confirmLabel="delete saves"
              title="Delete saved companies and restart"
              onConfirm={() => bridge().resetGame()}
            />
          }
        />
      );
    }
    case "text": {
      return (
        <input
          value={prompt.value}
          onChange={(e) => prompt.onChange(e.target.value)}
          placeholder={prompt.placeholder}
          className="px-field ob-field"
          autoFocus
        />
      );
    }
    case "pitch": {
      return (
        <textarea
          value={prompt.value}
          onChange={(e) => prompt.onChange(e.target.value)}
          rows={2}
          placeholder={prompt.placeholder}
          className="px-field ob-field resize-none"
          autoFocus
        />
      );
    }
    // no default
  }
};

const OnboardingActions = ({
  step,
  last,
  promptOpen,
  prompt,
  auth,
  menu,
  onLogin,
  onSkip,
  onBack,
}: {
  step: Step;
  last: boolean;
  promptOpen: boolean;
  prompt: Prompt | null;
  auth: Auth;
  menu: Menu | null;
  onLogin: () => void;
  onSkip: () => void;
  onBack: () => void;
}) => (
  <div className="ob-actions">
    {promptOpen && prompt?.kind === "auth" ? (
      <div className="ob-auth">
        <PromptField prompt={prompt} auth={auth} onLogin={onLogin} />
      </div>
    ) : null}
    {menu ? <ChoiceMenu menu={menu} className="ob-menu" /> : null}
    {last ? null : (
      <button type="button" onClick={onSkip} className="px-link" title="Tab">
        skip ▸
      </button>
    )}
    {promptOpen && BACK_STEP[step] !== null ? (
      <button type="button" onClick={onBack} className="px-link" title="Esc">
        ← back
      </button>
    ) : null}
  </div>
);

const promptFor = (
  step: Step,
  form: {
    founderName: string;
    companyName: string;
    pitch: string;
    biz: BusinessTypeId | null;
    setFounderName: (v: string) => void;
    setCompanyName: (v: string) => void;
    setPitch: (v: string) => void;
  },
): Prompt | null => {
  switch (step) {
    case "auth": {
      return { kind: "auth" };
    }
    case "founder": {
      return {
        kind: "text",
        onChange: form.setFounderName,
        placeholder: "Ada",
        value: form.founderName,
      };
    }
    case "company": {
      return {
        kind: "text",
        onChange: form.setCompanyName,
        placeholder: "Acme AI",
        value: form.companyName,
      };
    }
    case "pitch": {
      return {
        kind: "pitch",
        onChange: form.setPitch,
        placeholder: businessTypeById(form.biz ?? "custom").pitchPlaceholder,
        value: form.pitch,
      };
    }
    case "title":
    case "intro":
    case "look":
    case "biztype":
    case "team":
    case "budget":
    case "finalize": {
      return null;
    }
    // no default
  }
};

const hintFor = (step: Step, look: number, looks: number, capUsd: number | null): string | null => {
  switch (step) {
    case "founder":
    case "company": {
      return "Enter ↵";
    }
    case "pitch": {
      return "Enter ↵ · Shift+Enter for a new line";
    }
    case "look": {
      return looks > 1 ? `${look + 1} / ${looks} · ← → to browse` : null;
    }
    case "budget": {
      return capUsd === null
        ? "⚠ Uncapped. The office keeps spending while it works."
        : `New work stops at $${capUsd}; whatever is already running still finishes.`;
    }
    case "title":
    case "intro":
    case "auth":
    case "biztype":
    case "team":
    case "finalize": {
      return null;
    }
    // no default
  }
};

const LookArrow = ({ side, onClick }: { side: "l" | "r"; onClick: () => void }) => (
  <button
    type="button"
    className={`ob-arrow ob-arrow-${side}`}
    onClick={onClick}
    aria-label={side === "l" ? "previous look" : "next look"}
  >
    {side === "l" ? "◀" : "▶"}
  </button>
);

const Encounter = ({
  step,
  seed,
  looks,
  team,
  capUsd,
  founderName,
  companyName,
  onPrevLook,
  onNextLook,
}: {
  step: Step;
  seed: string;
  looks: number;
  team: Team;
  capUsd: number | null;
  founderName: string;
  companyName: string;
  onPrevLook: () => void;
  onNextLook: () => void;
}) => {
  const pickingLook = step === "look";
  const showingTeam = step === "team" && team.kind === "cast";
  const showingPanel = showingTeam || step === "budget";
  return (
    <div className="ob-stage" data-look={pickingLook} data-panel={showingPanel}>
      <OfficeBackdrop />
      <div className="ob-status ob-status-guide px-plate">
        <strong>Chad Runwayson</strong>
        <span>Your first investor</span>
      </div>
      {pickingLook ? (
        <>
          {looks > 1 ? <LookArrow side="l" onClick={onPrevLook} /> : null}
          <FounderSprite seed={seed} facing="front" />
          {looks > 1 ? <LookArrow side="r" onClick={onNextLook} /> : null}
        </>
      ) : (
        <>
          <Narrator thinking={step === "team" && team.kind === "casting"} />
          {showingPanel ? null : <FounderSprite seed={seed} facing="back" />}
        </>
      )}
      {showingPanel ? (
        <div className="ob-panel">
          {showingTeam && team.kind === "cast" ? <TeamParade hires={team.hires} /> : null}
          {step === "budget" ? <BudgetMeter capUsd={capUsd} /> : null}
        </div>
      ) : null}
      <div className="ob-status ob-status-founder px-plate">
        <div className="ob-status-row">
          <strong>{companyName || founderName || "New founder"}</strong>
          <div className="ob-progress">
            <span className="sr-only">{`${completedSteps(step)} of ${FOUNDING_STEPS.length} founding steps complete`}</span>
            {FOUNDING_STEPS.map((item, index) => (
              <span key={item} data-lit={index < completedSteps(step)} aria-hidden />
            ))}
          </div>
        </div>
        <span>{STEP_LABELS[step]}</span>
      </div>
    </div>
  );
};

export const Onboarding = () => {
  const [step, setStep] = useState<Step>("title");
  const [founderName, setFounderName] = useState("");
  const founderChoices = useAsync(loadFounderChoices, []);
  const choices = founderChoices.kind === "ready" ? founderChoices.value : [];
  const [look, setLook] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [biz, setBiz] = useState<BusinessTypeId | null>(null);
  const [pitch, setPitch] = useState("");
  const [team, setTeam] = useState<Team>({ kind: "uncast" });
  const [capIndex, setCapIndex] = useState(DEFAULT_CAP_INDEX);
  const [failure, setFailure] = useState<string | null>(null);
  const [cursor, setCursor] = useKeyedState(step, 0);

  const capUsd = CAPS[capIndex] ?? null;

  useModal();

  const { auth, login } = useAuthFlow({
    // a beat on "Connected ✓" before the founder's own step
    onSignedIn: () => window.setTimeout(() => setStep("founder"), 700),
    probe: true,
  });

  const script = useScript(`${step}:${team.kind}`, scriptFor(step, founderName, companyName, team));

  /** Ask a real CLI to cast a founding team for this pitch. Costs money. */
  const castTeam = () => {
    setFailure(null);
    // a retry keeps the step, so the new team's menu would open on "Search
    // again", one Enter from another paid search
    setCursor(0);
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
  };

  /** The company is on disk; the office opens once the copy here has it. */
  const openOffice = async () => {
    setFailure(null);
    try {
      await refresh();
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  const finalize = async () => {
    if (team.kind !== "cast" || team.hires.length === 0 || step === "finalize") {
      return;
    }
    const budget: Budget = capUsd === null ? { mode: "infinite" } : { capUsd, mode: "capped" };
    setFailure(null);
    setStep("finalize");
    try {
      await bridge().foundCompany({
        budget,
        businessType: biz ?? "custom",
        founderName: founderName.trim(),
        founderSpriteSeed: choices[look] ?? DEFAULT_FOUNDER_SEED,
        hires: team.hires,
        mission: pitch.trim(),
        name: companyName.trim(),
      });
    } catch (error) {
      setFailure(errorMessage(error));
      setStep("budget");
      return;
    }
    officeReady();
    await openOffice();
  };

  const looks = choices.length;
  const nextLook = () => setLook((i) => (looks === 0 ? 0 : (i + 1) % looks));
  const prevLook = () => setLook((i) => (looks === 0 ? 0 : (i + looks - 1) % looks));

  /** The choice window under the current step, if it has one. */
  const menuFor = (): Menu | null => {
    switch (step) {
      case "look": {
        return {
          cursor,
          items: LOOK_ITEMS,
          pick: (i) => (i === 0 ? setStep("company") : nextLook()),
          setCursor,
        };
      }
      case "biztype": {
        return {
          cursor,
          items: BIZ_ITEMS,
          pick: (i) => {
            const b = BUSINESS_TYPES[i];
            if (b) {
              setBiz(b.id);
              setStep("pitch");
            }
          },
          setCursor,
        };
      }
      case "team": {
        if (team.kind === "cast") {
          return {
            cursor,
            items: CAST_ITEMS,
            pick: (i) => (i === 0 ? setStep("budget") : castTeam()),
            setCursor,
          };
        }
        if (team.kind === "failed") {
          return {
            cursor,
            items: FAILED_ITEMS,
            pick: (i) => {
              if (i === 0) {
                castTeam();
              } else {
                setTeam({ kind: "uncast" });
                setStep("pitch");
              }
            },
            setCursor,
          };
        }
        return null;
      }
      case "budget": {
        // the cursor is the answer itself, so it outlives the step
        return {
          cursor: capIndex,
          items: CAP_ITEMS,
          pick: (i) => {
            setCapIndex(i);
            void finalize();
          },
          setCursor: setCapIndex,
        };
      }
      case "finalize": {
        // founded already, and main refuses a second founding: only the refresh is retried
        if (failure === null) {
          return null;
        }
        return {
          cursor,
          items: OPEN_FAILED_ITEMS,
          pick: () => {
            void openOffice();
          },
          setCursor,
        };
      }
      case "title":
      case "intro":
      case "auth":
      case "founder":
      case "company":
      case "pitch": {
        return null;
      }
      // no default
    }
  };
  const menu = script.promptOpen ? menuFor() : null;

  /** Enter, once the page is read: the step's own confirm. */
  const confirm = () => {
    setFailure(null);
    if (menu) {
      menu.pick(menu.cursor);
      return;
    }
    switch (step) {
      case "intro": {
        // the CLI probe has to land first — routing before it would send a
        // signed-in founder to the login screen
        if (auth.phase !== "checking") {
          setStep(auth.phase === "signed-in" ? "founder" : "auth");
        }
        break;
      }
      case "auth": {
        // logging-in already has a browser open; signed-in moves on by itself
        if (auth.phase === "signed-out" || auth.phase === "login-failed") {
          login();
        }
        break;
      }
      case "founder": {
        if (founderName.trim()) {
          setStep("look");
        }
        break;
      }
      case "company": {
        if (companyName.trim()) {
          setStep("biztype");
        }
        break;
      }
      case "pitch": {
        if (pitch.trim()) {
          castTeam();
        }
        break;
      }
      // a menu answered above, or there is nothing to confirm yet
      case "title":
      case "look":
      case "biztype":
      case "team":
      case "budget":
      case "finalize": {
        break;
      }
      // no default
    }
  };

  const back = () => {
    const prev = BACK_STEP[step];
    if (prev !== null) {
      setFailure(null);
      setStep(prev);
    }
  };

  // Enter is the A button: it skips the typing, turns the page, then confirms.
  // The arrows move the menu cursor or cycle the looks; Escape rewinds.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.isComposing) {
      return;
    }
    if (e.key === "Escape") {
      back();
      return;
    }
    if (step === "title") {
      if (e.key === "Enter") {
        setStep("intro");
      }
      return;
    }
    if (e.key === "Tab" && !script.last) {
      e.preventDefault();
      script.skip();
      return;
    }
    if (step === "look") {
      if (e.key === "ArrowRight") {
        nextLook();
      } else if (e.key === "ArrowLeft") {
        prevLook();
      }
    }
    // a newline in the pitch is Shift+Enter
    const newline = document.activeElement?.tagName === "TEXTAREA" && e.shiftKey;
    if (e.key !== "Enter" || newline) {
      return;
    }
    // a focused button answers its own Enter, and cancelling the keydown would
    // swallow its click. Not the dialogue box: its click confirms only the intro.
    if (e.target instanceof HTMLButtonElement && !e.target.classList.contains("ob-box-text")) {
      return;
    }
    e.preventDefault();
    if (script.advance()) {
      confirm();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const problem = failure ?? (team.kind === "failed" ? team.message : null);
  // Enter on the intro's last page waits for the probe; say so instead of doing nothing
  const hint =
    step === "intro" && auth.phase === "checking"
      ? "Checking your CLI…"
      : hintFor(step, look, looks, capUsd);
  const seed = choices[look] ?? DEFAULT_FOUNDER_SEED;
  const prompt = promptFor(step, {
    biz,
    companyName,
    founderName,
    pitch,
    setCompanyName,
    setFounderName,
    setPitch,
  });

  if (step === "title") {
    return (
      <div
        className="ob-scene pointer-events-auto absolute inset-0 z-40 overflow-hidden"
        data-frame="title"
      >
        <Backdrop />
        <TitleScreen onStart={() => setStep("intro")} />
        <div className="ob-title-footer">An idle business adventure</div>
      </div>
    );
  }

  return (
    <div
      className="ob-scene pointer-events-auto absolute inset-0 z-40 overflow-hidden"
      data-frame="encounter"
    >
      <div className="ob-encounter">
        <Encounter
          step={step}
          seed={seed}
          looks={looks}
          team={team}
          capUsd={capUsd}
          founderName={founderName}
          companyName={companyName}
          onPrevLook={prevLook}
          onNextLook={nextLook}
        />
        <div className="ob-dock px-battle">
          <Textbox
            shown={script.shown}
            done={script.done}
            last={script.last}
            onAdvance={() => {
              // a click on the text is the A button too, short of confirming a form
              if (script.advance() && step === "intro") {
                confirm();
              }
            }}
            hint={script.promptOpen ? hint : null}
            problem={problem}
          >
            {script.promptOpen && prompt && prompt.kind !== "auth" ? (
              <PromptField prompt={prompt} auth={auth} onLogin={login} />
            ) : null}
          </Textbox>
          <OnboardingActions
            step={step}
            last={script.last}
            promptOpen={script.promptOpen}
            prompt={prompt}
            auth={auth}
            menu={menu}
            onLogin={login}
            onSkip={() => script.skip()}
            onBack={back}
          />
        </div>
      </div>
    </div>
  );
};
