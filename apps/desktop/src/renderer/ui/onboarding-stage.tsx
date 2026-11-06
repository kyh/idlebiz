import type { CSSProperties } from "react";
import { sheetUrl } from "@/renderer/character-art";
import { Bust } from "@/renderer/ui/bust";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import { SHEET_COLUMNS, WALK_START } from "@repo/domain/character-frame";
import type { HireProposal } from "@repo/domain/hire";

export const Backdrop = () => <div className="ob-backdrop" aria-hidden />;

export const OfficeBackdrop = () => (
  <div className="ob-office" aria-hidden>
    <div className="ob-office-wall" />
    <div className="ob-office-floor" />
    <div className="ob-office-board" />
    <img className="ob-office-desk" src="/onboarding/office-desk.png" alt="" />
    <img className="ob-office-cooler" src="/onboarding/office-cooler.png" alt="" />
  </div>
);

type Facing = "front" | "back";

/** The office's standing pose: walk down's first frame, or walk up's. */
const STANDING = { back: WALK_START.up, front: WALK_START.down } satisfies Record<Facing, number>;

/** One frame of a whole sheet, scaled by the sprite's `--s`, as a CSS background. */
const frameBackground = (url: string, frame: number): CSSProperties => {
  const column = frame % SHEET_COLUMNS;
  const row = Math.floor(frame / SHEET_COLUMNS);
  return {
    backgroundImage: `url(${url})`,
    backgroundPosition: `calc(var(--ob-frame-w) * ${-column} * var(--s)) calc(var(--ob-frame-h) * ${-row} * var(--s))`,
    backgroundSize: `calc(var(--ob-frame-w) * ${SHEET_COLUMNS} * var(--s)) auto`,
  };
};

export const FounderSprite = ({ seed, facing }: { seed: string; facing: Facing }) => (
  <div
    key={seed}
    className="ob-founder"
    style={frameBackground(sheetUrl(seed), STANDING[facing])}
    aria-hidden
  />
);

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
