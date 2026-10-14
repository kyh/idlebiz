import { useEffect, useEffectEvent, useReducer, useState } from "react";
import { preload } from "react-dom";
import { useAuthFlow } from "@/renderer/hooks/use-auth-flow";
import type { Auth } from "@/renderer/hooks/use-auth-flow";
import { useKeyedState } from "@/renderer/hooks/use-keyed-state";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { api } from "@/renderer/api";
import { sheetUrl } from "@/renderer/character-art";
import { companyFounded } from "@/renderer/state/store";
import { AuthStep } from "@/renderer/ui/auth-step";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import { useModal } from "@/renderer/ui/modal";
import { BACK_STEP, START, failureOf, nextFlow, sceneOf } from "@/renderer/ui/onboarding-flow";
import type { Flow, Step } from "@/renderer/ui/onboarding-flow";
import {
  BIZ_ITEMS,
  CAPS,
  CAP_ITEMS,
  CAST_ITEMS,
  DEFAULT_CAP_INDEX,
  FAILED_ITEMS,
  FOUNDING_STEPS,
  LOOK_ITEMS,
  OPEN_FAILED_ITEMS,
  STEP_LABELS,
  completedSteps,
  hintFor,
  scriptFor,
} from "@/renderer/ui/onboarding-script";
import {
  BudgetMeter,
  Backdrop,
  FounderSprite,
  Narrator,
  OfficeBackdrop,
  TeamParade,
} from "@/renderer/ui/onboarding-stage";
import { ChoiceMenu } from "@/renderer/ui/choice-menu";
import type { Menu } from "@/renderer/ui/choice-menu";
import { ConfirmLink } from "@/renderer/ui/confirm-link";
import { TypeCursor } from "@/renderer/ui/type-cursor";
import {
  BUSINESS_TYPES,
  DEFAULT_FOUNDER_SEED,
  businessTypeById,
  missionFromPitch,
} from "@repo/domain/domain";
import type { Budget, BusinessTypeId } from "@repo/domain/domain";
import { founderChoices } from "@repo/domain/character-seed";
import { errorMessage } from "@repo/domain/errors";
import type { HireProposal } from "@repo/domain/hire";

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

const LOOKS = founderChoices(6);

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
              title="Delete the save and restart"
              onConfirm={() => api.save.reset()}
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

/**
 * Pointer-only: a focused button answers Enter itself, so an arrow that kept
 * focus after a click would turn Enter into "next look". ← → browse instead.
 */
const LookArrow = ({ side, onClick }: { side: "l" | "r"; onClick: () => void }) => (
  <button
    type="button"
    className={`ob-arrow ob-arrow-${side}`}
    tabIndex={-1}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    aria-label={side === "l" ? "previous look" : "next look"}
  >
    {side === "l" ? "◀" : "▶"}
  </button>
);

const Encounter = ({
  flow,
  seed,
  looks,
  capUsd,
  founderName,
  companyName,
  onPrevLook,
  onNextLook,
}: {
  flow: Flow;
  seed: string;
  looks: number;
  capUsd: number | null;
  founderName: string;
  companyName: string;
  onPrevLook: () => void;
  onNextLook: () => void;
}) => {
  const { step } = flow;
  const pickingLook = step === "look";
  const team = step === "team" ? flow.team : null;
  const showingPanel = team?.kind === "cast" || step === "budget";
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
          <Narrator thinking={team?.kind === "casting"} />
          {showingPanel ? null : <FounderSprite seed={seed} facing="back" />}
        </>
      )}
      {showingPanel ? (
        <div className="ob-panel">
          {team?.kind === "cast" ? <TeamParade hires={team.hires} /> : null}
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
  const [flow, dispatch] = useReducer(nextFlow, START);
  const { step } = flow;
  const [founderName, setFounderName] = useState("");
  const [look, setLook] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [biz, setBiz] = useState<BusinessTypeId | null>(null);
  const [pitch, setPitch] = useState("");
  const [capIndex, setCapIndex] = useState(DEFAULT_CAP_INDEX);
  // Once founded the company is on disk and main refuses a second founding, so
  // only reading it back is retried; the office opens once the page holds it.
  const opening = useSubmission(companyFounded);
  const scene = sceneOf(flow);
  const [cursor, setCursor] = useKeyedState(scene, 0);

  const capUsd = CAPS[capIndex] ?? null;

  useModal();

  // each look fetched as soon as it is on offer, so browsing them is instant
  for (const seed of LOOKS) {
    preload(sheetUrl(seed), { as: "image" });
  }

  // a beat on "Connected ✓" before the founder's own step
  const { auth, login } = useAuthFlow(() =>
    window.setTimeout(() => dispatch({ kind: "signed-in" }), 700),
  );

  const mission = missionFromPitch(pitch);
  const script = useScript(scene, scriptFor(flow, founderName, companyName, mission !== null));

  // Casting and founding stay off useSubmission: the flow holds how each went.
  // A submission's failure stays until its next submit, so a failed cast would
  // still show after "Rewrite the pitch", and an action would hold the founding
  // screen until main answered. Each call follows the flow into the step that
  // names it, so every way there (Enter, either menu) makes it once.

  /** Ask a real CLI to cast a founding team for this pitch. Costs money. */
  const cast = useEffectEvent(async () => {
    try {
      const hires = await api.onboarding.hires({
        businessType: biz ?? "custom",
        companyName: companyName.trim(),
        mission,
      });
      dispatch({ hires, kind: "cast" });
    } catch (error) {
      dispatch({ kind: "cast-failed", message: errorMessage(error) });
    }
  });
  const casting = step === "team" && flow.team.kind === "casting";
  useEffect(() => {
    if (casting) {
      void cast();
    }
  }, [casting]);

  const found = useEffectEvent(async (hires: HireProposal[]) => {
    const budget: Budget = capUsd === null ? { mode: "infinite" } : { capUsd, mode: "capped" };
    try {
      await api.onboarding.found({
        budget,
        businessType: biz ?? "custom",
        founderName: founderName.trim(),
        founderSpriteSeed: LOOKS[look] ?? DEFAULT_FOUNDER_SEED,
        hires,
        mission,
        name: companyName.trim(),
      });
    } catch (error) {
      dispatch({ kind: "found-failed", message: errorMessage(error) });
      return;
    }
    opening.submit();
  });
  const founding = step === "finalize" ? flow.hires : null;
  useEffect(() => {
    if (founding) {
      void found(founding);
    }
  }, [founding]);

  const forward = () => dispatch({ auth: auth.phase, companyName, founderName, kind: "next" });
  const back = () => dispatch({ kind: "back" });

  const looks = LOOKS.length;
  const nextLook = () => setLook((i) => (i + 1) % looks);
  const prevLook = () => setLook((i) => (i + looks - 1) % looks);

  /** The choice window under the current step, if it has one. */
  const menuFor = (): Menu | null => {
    switch (flow.step) {
      case "look": {
        return {
          cursor,
          items: LOOK_ITEMS,
          pick: (i) => (i === 0 ? forward() : nextLook()),
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
              forward();
            }
          },
          setCursor,
        };
      }
      case "team": {
        if (flow.team.kind === "cast") {
          return {
            cursor,
            items: CAST_ITEMS,
            pick: (i) => (i === 0 ? forward() : dispatch({ kind: "recast" })),
            setCursor,
          };
        }
        if (flow.team.kind === "failed") {
          return {
            cursor,
            items: FAILED_ITEMS,
            pick: (i) => dispatch({ kind: i === 0 ? "recast" : "rewrite" }),
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
            forward();
          },
          setCursor: setCapIndex,
        };
      }
      case "finalize": {
        if (opening.submission.kind !== "failed") {
          return null;
        }
        return { cursor, items: OPEN_FAILED_ITEMS, pick: () => opening.submit(), setCursor };
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
    if (menu) {
      menu.pick(menu.cursor);
      return;
    }
    if (step === "auth") {
      // logging-in already has a browser open; signed-in moves on by itself
      if (auth.phase === "signed-out" || auth.phase === "login-failed") {
        login();
      }
      return;
    }
    forward();
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
        forward();
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

  const problem =
    failureOf(flow) ?? (opening.submission.kind === "failed" ? opening.submission.message : null);
  // Enter on the intro's last page waits for the probe; say so instead of doing nothing
  const hint =
    step === "intro" && auth.phase === "checking"
      ? "Checking your CLI…"
      : hintFor(step, look, looks, capUsd);
  const seed = LOOKS[look] ?? DEFAULT_FOUNDER_SEED;
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
        <TitleScreen onStart={forward} />
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
          flow={flow}
          seed={seed}
          looks={looks}
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
