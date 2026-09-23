import { getCharacterAssets } from "@/renderer/character-assets";
import { useAsync } from "@/renderer/hooks/use-async";
import { Bust } from "@/renderer/ui/bust";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import type { HireProposal } from "@/shared/hire";

export const Backdrop = () => <div className="ob-backdrop" aria-hidden />;

export const OfficeBackdrop = () => (
  <div className="ob-office" aria-hidden>
    <div className="ob-office-wall" />
    <div className="ob-office-floor" />
    <div className="ob-office-board" />
    <img className="ob-office-desk" src="./onboarding/office-desk.png" alt="" />
    <img className="ob-office-cooler" src="./onboarding/office-cooler.png" alt="" />
  </div>
);

/** The same 32 × 64 character frame used in the office: down in row 0, up in row 3. */
export const FounderSprite = ({ seed, facing }: { seed: string; facing: "front" | "back" }) => {
  const assets = useAsync(() => getCharacterAssets(seed), [seed]);
  return (
    <div
      key={seed}
      className="ob-founder"
      data-facing={facing}
      style={
        assets.kind === "ready"
          ? { backgroundImage: `url(${assets.value.walkSheetDataUrl})` }
          : undefined
      }
      aria-hidden
    />
  );
};

export const Narrator = ({ thinking = false }: { thinking?: boolean }) => (
  <div className="ob-mentor" aria-hidden>
    {thinking ? <span className="ob-emote px-plate">…</span> : null}
  </div>
);

export const TeamParade = ({ hires }: { hires: HireProposal[] }) => (
  <div className="ob-parade px-window px-scroll">
    {hires.map((h) => (
      <div key={h.spriteSeed} className="ob-team-member px-inset">
        <Bust seed={h.spriteSeed} size="md" />
        <span className="min-w-0">
          <EmployeeTag name={h.name} title={h.title} />
          <span className="block text-xs text-fg-dim">{h.blurb}</span>
        </span>
      </div>
    ))}
  </div>
);

/** The biggest cap on offer; the bar is full there. */
const METER_FULL_USD = 50;

type Tone = "tight" | "mid" | "open" | "infinite";
const toneOf = (capUsd: number | null): Tone => {
  if (capUsd === null) {
    return "infinite";
  }
  if (capUsd <= 5) {
    return "tight";
  }
  return capUsd <= 20 ? "mid" : "open";
};

export const BudgetMeter = ({ capUsd }: { capUsd: number | null }) => {
  const width = capUsd === null ? 100 : Math.min(100, (capUsd / METER_FULL_USD) * 100);
  return (
    <div className="ob-meter px-window">
      <span className="text-xs text-fg-dim">Budget</span>
      <div className="ob-meter-bar">
        <div className="ob-meter-fill" data-tone={toneOf(capUsd)} style={{ width: `${width}%` }} />
      </div>
      <span className="text-sm tabular-nums text-fg">{capUsd === null ? "∞" : `$${capUsd}`}</span>
    </div>
  );
};
