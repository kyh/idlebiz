import { useEffect, useEffectEvent, useState } from "react";
import { getCharacterAssets } from "@/renderer/character-assets";
import { useAsync } from "@/renderer/hooks/use-async";
import { useAuthFlow } from "@/renderer/hooks/use-auth-flow";
import type { Auth } from "@/renderer/hooks/use-auth-flow";
import { useKeyedState } from "@/renderer/hooks/use-keyed-state";
import { useTypewriter } from "@/renderer/hooks/use-typewriter";
import { bridge } from "@/renderer/bridge";
import { refresh } from "@/renderer/state/store";
import { AuthStep } from "@/renderer/ui/auth-step";
import { useModal } from "@/renderer/ui/modal";
import {
  BudgetMeter,
  Building,
  FLOORS,
  FounderCloseUp,
  FounderSprite,
  Narrator,
  NightSky,
  TeamParade,
} from "@/renderer/ui/onboarding-stage";
import { ChoiceMenu } from "@/renderer/ui/choice-menu";
import type { Menu, MenuItem } from "@/renderer/ui/choice-menu";
import { TypeCursor } from "@/renderer/ui/type-cursor";
import { BUSINESS_TYPES, DEFAULT_FOUNDER_SEED, businessTypeById } from "@/shared/domain";
import type { Budget, BusinessTypeId } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import type { HireProposal } from "@/shared/ipc-registry";

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

/** The camera: up close on whoever is talking, or wide on the street. */
const frameOf = (step: Step): "title" | "closeup" | "street" => {
  switch (step) {
    case "title": {
      return "title";
    }
    case "intro":
    case "auth":
    case "founder":
    case "look": {
      return "closeup";
    }
    default: {
      return "street";
    }
  }
};

/** Where the founder stands on the street, per step: from the left edge to the door. */
const FOUNDER_AT = new Map<Step, number>([
  ["company", 22],
  ["biztype", 34],
  ["pitch", 44],
  ["team", 52],
  ["budget", 56],
  ["finalize", 84],
]);

/** Where "back" goes, or null where it doesn't go anywhere. Only the cheap,
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

/** The finale — the walk to the door, the step inside, the flash — must play out
 *  before the office is allowed to show. Matches the `.ob-flash` delay + length. */
const FINALE_MS = 2200;

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
    default: {
      return ["Hang on, let me text my recruiter…", "…she's reviewing resumes…"];
    }
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
  try {
    const seeds = await bridge().getFounderChoices();
    for (const seed of seeds) {
      void getCharacterAssets(seed);
    }
    return seeds;
  } catch {
    return [];
  }
};

const TitleScreen = () => (
  <div className="ob-title-screen">
    <div className="ob-title">IDLEBIZ</div>
    <div className="mt-4 text-xs tracking-wide text-[#8a90ab]">a startup that runs itself</div>
    <div className="px-blink mt-10 text-sm text-light">▶ PRESS ENTER</div>
  </div>
);

const Textbox = ({
  shown,
  done,
  last,
  onAdvance,
  onSkip,
  hint,
  problem,
  children,
}: {
  shown: string;
  done: boolean;
  last: boolean;
  onAdvance: () => void;
  onSkip: () => void;
  hint: string | null;
  problem: string | null;
  children: React.ReactNode;
}) => (
  <div className="ob-box px-battle">
    <button type="button" className="ob-box-text" onClick={onAdvance}>
      {shown}
      <TypeCursor done={done} more={!last} />
    </button>
    {last ? null : (
      <button type="button" onClick={onSkip} className="px-link ob-skip" title="Tab">
        skip ▸
      </button>
    )}
    {children}
    {problem ? <div className="px-hint text-danger">{problem}</div> : null}
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
    default: {
      return null;
    }
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
    default: {
      return null;
    }
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

/** The close-up: Chad talking, or the founder being picked. */
const CloseUp = ({
  step,
  seed,
  looks,
  onPrevLook,
  onNextLook,
}: {
  step: Step;
  seed: string;
  looks: number;
  onPrevLook: () => void;
  onNextLook: () => void;
}) => (
  <div className="ob-stage">
    {step === "look" ? (
      <>
        {looks > 1 ? <LookArrow side="l" onClick={onPrevLook} /> : null}
        <FounderCloseUp seed={seed} />
        {looks > 1 ? <LookArrow side="r" onClick={onNextLook} /> : null}
      </>
    ) : (
      <Narrator frame="closeup" />
    )}
  </div>
);

/** The street: the office on the right, Chad at its door, the founder walking up. */
const Street = ({
  step,
  team,
  capUsd,
  seed,
}: {
  step: Step;
  team: Team;
  capUsd: number | null;
  seed: string;
}) => {
  const at = FOUNDER_AT.get(step) ?? null;
  return (
    <div className="ob-stage">
      <div className="ob-panel">
        {step === "team" && team.kind === "cast" ? <TeamParade hires={team.hires} /> : null}
        {step === "budget" ? <BudgetMeter capUsd={capUsd} /> : null}
      </div>
      <Building lit={litFloors(step)} open={step === "finalize"} />
      <Narrator frame="street" thinking={step === "team" && team.kind === "casting"} />
      {at === null ? null : <FounderSprite seed={seed} at={at} entering={step === "finalize"} />}
    </div>
  );
};

export const Onboarding = () => {
  const [step, setStep] = useState<Step>("title");
  const [founderName, setFounderName] = useState("");
  const choices = useAsync(loadFounderChoices, []) ?? [];
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

  const finalize = async () => {
    if (team.kind !== "cast" || team.hires.length === 0 || step === "finalize") {
      return;
    }
    const budget: Budget = capUsd === null ? { mode: "infinite" } : { capUsd, mode: "capped" };
    setFailure(null);
    setStep("finalize");
    try {
      // the flash plays over the night; only then does the office get to show
      await Promise.all([
        bridge().foundCompany({
          budget,
          businessType: biz ?? "custom",
          founderName: founderName.trim(),
          founderSpriteSeed: choices[look] ?? DEFAULT_FOUNDER_SEED,
          hires: team.hires,
          mission: pitch.trim(),
          name: companyName.trim(),
        }),
        // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, FINALE_MS);
        }),
      ]);
      await refresh();
      window.dispatchEvent(new CustomEvent("idlebiz:onboarded"));
    } catch (error) {
      setFailure(errorMessage(error));
      setStep("budget");
    }
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
      default: {
        return null;
      }
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
      default: {
        break;
      }
    }
  };

  const back = () => {
    const prev = backStep(step);
    if (prev !== null) {
      setFailure(null);
      setStep(prev);
    }
  };

  // Enter is the A button: it skips the typing, turns the page, then confirms.
  // The arrows move the menu cursor or cycle the looks; Escape rewinds.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
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
  const frame = frameOf(step);
  const prompt = promptFor(step, {
    biz,
    companyName,
    founderName,
    pitch,
    setCompanyName,
    setFounderName,
    setPitch,
  });

  if (frame === "title") {
    return (
      <div className="ob-scene pointer-events-auto absolute inset-0 z-40 overflow-hidden">
        <NightSky dim={false} />
        <button type="button" className="ob-title-hit" onClick={() => setStep("intro")}>
          <TitleScreen />
        </button>
      </div>
    );
  }

  return (
    <div className="ob-scene pointer-events-auto absolute inset-0 z-40 overflow-hidden">
      <NightSky dim={frame === "closeup"} />
      {frame === "closeup" ? (
        <CloseUp
          step={step}
          seed={seed}
          looks={looks}
          onPrevLook={prevLook}
          onNextLook={nextLook}
        />
      ) : (
        <Street step={step} team={team} capUsd={capUsd} seed={seed} />
      )}
      <div className="ob-street" />
      <div className="ob-ground" />

      <div className="ob-dock">
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
          onSkip={() => script.skip()}
          hint={script.promptOpen ? hint : null}
          problem={problem}
        >
          {script.promptOpen && prompt ? (
            <PromptField prompt={prompt} auth={auth} onLogin={login} />
          ) : null}
          {backStep(step) === null || !script.promptOpen ? null : (
            <button type="button" onClick={back} className="px-link ob-back" title="Esc">
              ← back
            </button>
          )}
        </Textbox>
        {menu ? <ChoiceMenu menu={menu} className="ob-menu" /> : null}
      </div>
      {step === "finalize" ? <div className="ob-flash" /> : null}
    </div>
  );
};
