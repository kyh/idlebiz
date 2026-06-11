import { useCallback, useEffect, useRef, useState } from "react";
import { setModalOpen, refresh, getPortrait } from "@/renderer/state/store";
import { BUSINESS_TYPES, businessTypeById } from "@/shared/domain";
import type { BusinessTypeId } from "@/shared/domain";
import type { AuthFlowEvent, FounderChoice, HireProposal } from "@/shared/ipc-registry";

// ---------------------------------------------------------------------------
// Pokémon-style first-run onboarding: one battle box, a narrator, and a step
// machine — auth → founder → look → company → biztype → pitch → team → office.
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
  | "finalize";

const bridge = () => {
  const b = window.appBridge;
  if (!b) throw new Error("appBridge unavailable");
  return b;
};

/** Typewriter text; click/Enter elsewhere skips to the end. */
function useTypewriter(text: string): { shown: string; done: boolean; skip: () => void } {
  const [n, setN] = useState(0);
  const target = useRef(text);
  useEffect(() => {
    target.current = text;
    setN(0);
    const t = setInterval(() => {
      setN((cur) => {
        if (cur >= target.current.length) {
          clearInterval(t);
          return cur;
        }
        return cur + 2;
      });
    }, 16);
    return () => clearInterval(t);
  }, [text]);
  const done = n >= text.length;
  return { shown: text.slice(0, n), done, skip: () => setN(text.length) };
}

function Narrator({ text }: { text: string }) {
  const { shown, done, skip } = useTypewriter(text);
  return (
    <div
      className="min-h-[44px] cursor-pointer text-[14px] leading-relaxed text-[var(--text)]"
      onClick={skip}
    >
      {shown}
      {!done ? <span className="px-live-dot">▌</span> : null}
    </div>
  );
}

export function PokeOnboarding() {
  const [step, setStep] = useState<Step>("intro");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [authLines, setAuthLines] = useState<string[]>([]);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [code, setCode] = useState("");
  const [founderName, setFounderName] = useState("");
  const [choices, setChoices] = useState<FounderChoice[]>([]);
  const [look, setLook] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [biz, setBiz] = useState<BusinessTypeId | null>(null);
  const [pitch, setPitch] = useState("");
  const [hires, setHires] = useState<HireProposal[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);

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
        setAuthUrl(e.url);
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

  const next = useCallback(() => {
    setError(null);
    if (step === "intro") setStep(authed ? "founder" : "auth");
    else if (step === "founder" && founderName.trim()) setStep("look");
    else if (step === "look") setStep("company");
    else if (step === "company" && companyName.trim()) setStep("biztype");
    else if (step === "biztype" && biz !== null) setStep("pitch");
    else if (step === "pitch" && pitch.trim()) {
      setStep("team");
      setHires(null);
      void bridge()
        .generateHires({
          companyName: companyName.trim(),
          mission: pitch.trim(),
          businessType: biz ?? "custom",
        })
        .then((h) => {
          setHires(h);
          setPicked(new Set(h.map((_, i) => i)));
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [step, authed, founderName, companyName, biz, pitch]);

  const finalize = async () => {
    if (!hires || picked.size === 0 || finalizing) return;
    setFinalizing(true);
    setStep("finalize");
    try {
      const seed = choices[look]?.seed ?? "founder-player-001";
      const co = await bridge().createCompany({
        name: companyName.trim(),
        mission: pitch.trim(),
        businessType: biz ?? "custom",
        founderName: founderName.trim(),
        founderSpriteSeed: seed,
      });
      await bridge().batchHire({ companyId: co.id, hires: hires.filter((_, i) => picked.has(i)) });
      await bridge().completeOnboarding({ companyId: co.id });
      await refresh();
      window.dispatchEvent(new CustomEvent("idlebiz:onboarded"));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setFinalizing(false);
      setStep("team");
    }
  };

  // Enter advances input steps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const tag = document.activeElement?.tagName;
      if (tag === "TEXTAREA") return;
      next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next]);

  const narration: Record<Step, string> = {
    intro:
      "Welcome to IDLEBIZ! You're about to found a startup staffed by real AI employees — they write real code and real docs in a real folder on your computer.",
    auth: "First things first: connect your OpenAI account. It's what powers your employees — no connection, no workforce.",
    founder: "Let's get you on payroll. What's your name, founder?",
    look: "Pick your look. This is how you'll appear around the office.",
    company: "Now the fun part. What's your company called?",
    biztype: `What kind of company is ${companyName.trim() || "this"} going to be?`,
    pitch: `What is ${companyName.trim() || "your company"} building? Be specific — your team will literally start working on this.`,
    team:
      hires === null
        ? "Putting out the job posting… reviewing resumes…"
        : "Here's your founding team. Uncheck anyone you don't want — then let's open the office!",
    finalize: "Signing the lease… assembling desks… your office is ready!",
  };

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

        {step === "team" && hires ? (
          <div className="px-window grid max-h-[46vh] w-full grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
            {hires.map((h, i) => (
              <button
                key={h.spriteSeed}
                onClick={() =>
                  setPicked((p) => {
                    const n = new Set(p);
                    if (n.has(i)) n.delete(i);
                    else n.add(i);
                    return n;
                  })
                }
                className="px-inset flex items-start gap-2 p-2 text-left"
                style={{ opacity: picked.has(i) ? 1 : 0.45 }}
              >
                <Portrait seed={h.spriteSeed} />
                <span>
                  <span className="block text-[13px] text-[var(--text)]">
                    {picked.has(i) ? "☑" : "☐"} {h.name} ·{" "}
                    <span className="text-[var(--accent-lo)]">{h.title}</span>
                  </span>
                  <span className="block text-[10px] text-[var(--text-dim)]">{h.blurb}</span>
                </span>
              </button>
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

        <div className="mt-3 flex items-center gap-2">
          {step === "intro" ? (
            <button onClick={next} className="px-btn-accent px-btn ml-auto text-[13px]">
              ▶ Let's go
            </button>
          ) : null}

          {step === "auth" ? (
            <div className="flex w-full flex-col gap-2">
              {authLines.length > 0 ? (
                <div className="px-inset max-h-20 overflow-y-auto p-2 text-[11px] text-[var(--text-dim)]">
                  {authLines.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
              ) : null}
              {authUrl ? (
                <div className="flex gap-2">
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="…or paste the code from the browser here"
                    className="px-field flex-1 text-[12px]"
                  />
                  <button
                    onClick={() => {
                      if (code.trim()) void bridge().submitAuthCode({ code: code.trim() });
                    }}
                    className="px-btn text-[12px]"
                  >
                    Submit
                  </button>
                </div>
              ) : null}
              <div className="flex items-center">
                <button
                  onClick={() => void bridge().resetGame()}
                  className="cursor-pointer border-none bg-transparent text-[11px] text-[var(--text-dim)] hover:text-[var(--danger)]"
                  title="Wipe everything in ~/.idlebiz and restart"
                >
                  ↺ start over
                </button>
                <button
                  onClick={() => {
                    setAuthBusy(true);
                    setAuthLines([]);
                    void bridge().startLogin();
                  }}
                  disabled={authBusy}
                  className="px-btn-accent px-btn ml-auto text-[13px]"
                >
                  {authBusy
                    ? "Waiting for authorization…"
                    : authUrl
                      ? "Try again"
                      : "Connect OpenAI account"}
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
                className="px-field flex-1 text-[14px]"
                autoFocus
              />
              <button
                onClick={next}
                disabled={!founderName.trim()}
                className="px-btn-accent px-btn text-[13px]"
              >
                That's me
              </button>
            </>
          ) : null}

          {step === "look" ? (
            <button onClick={next} className="px-btn-accent px-btn ml-auto text-[13px]">
              Looking sharp →
            </button>
          ) : null}

          {step === "company" ? (
            <>
              <input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme AI"
                className="px-field flex-1 text-[14px]"
                autoFocus
              />
              <button
                onClick={next}
                disabled={!companyName.trim()}
                className="px-btn-accent px-btn text-[13px]"
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
                    key={b.id}
                    onClick={() => setBiz(b.id)}
                    data-sel={biz === b.id}
                    className="px-opt text-left text-[13px]"
                  >
                    {b.emoji} {b.label}
                  </button>
                ))}
              </div>
              <button
                onClick={next}
                disabled={biz === null}
                className="px-btn-accent px-btn ml-auto text-[13px]"
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
                className="px-field w-full resize-none text-[13px]"
                autoFocus
              />
              <button
                onClick={next}
                disabled={!pitch.trim()}
                className="px-btn-accent px-btn ml-auto text-[13px]"
              >
                That's the vision
              </button>
            </div>
          ) : null}

          {step === "team" && hires ? (
            <button
              onClick={() => void finalize()}
              disabled={picked.size === 0 || finalizing}
              className="px-btn-accent px-btn ml-auto text-[13px]"
            >
              Hire {picked.size} & open the office →
            </button>
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
    void getPortrait(seed).then((u) => {
      if (alive) setUrl(u);
    });
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
