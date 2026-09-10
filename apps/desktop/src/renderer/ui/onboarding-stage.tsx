import { useEffect, useState } from "react";
import { getCharacterAssets } from "@/renderer/character-assets";
import { useAsync } from "@/renderer/hooks/use-async";
import { Bust } from "@/renderer/ui/bust";
import { EmployeeTag } from "@/renderer/ui/employee-tag";
import type { HireProposal } from "@/shared/ipc-registry";
import { cn } from "cn";

const STARS: readonly (readonly [number, number])[] = [
  [8, 12],
  [19, 6],
  [33, 15],
  [46, 4],
  [61, 11],
  [74, 18],
  [84, 5],
  [27, 26],
  [55, 24],
  [93, 22],
];

export const NightSky = ({ dim }: { dim: boolean }) => (
  <div className="pointer-events-none absolute inset-0" aria-hidden>
    <div className="ob-sky" data-dim={dim} />
    {STARS.map(([x, y], i) => (
      <span
        key={`${x}-${y}`}
        className="ob-star"
        style={{ animationDelay: `${(i * 370) % 2400}ms`, left: `${x}%`, top: `${y}%` }}
      />
    ))}
  </div>
);

/** The office sprite is 140 rows tall. Its floors light from the ground up;
 *  these are the rows where each floor's windows start, ground floor first,
 *  measured from the sprite's top. The scale it is drawn at is the CSS's business. */
const BUILDING_ROWS = 140;
const FLOOR_TOPS: readonly number[] = [128, 110, 91, 72, 53, 33, 14];
export const FLOORS = FLOOR_TOPS.length;

/** How far down from the top the lit layer starts showing: everything below the
 *  lowest dark floor's windows, as a share of the sprite's height. */
const litInset = (lit: number): string => {
  if (lit <= 0) {
    return "100%";
  }
  const top = FLOOR_TOPS[Math.min(lit, FLOORS) - 1] ?? 0;
  return `${((top - 1) / BUILDING_ROWS) * 100}%`;
};

export const Building = ({ lit, open }: { lit: number; open: boolean }) => (
  <div className="ob-building" aria-hidden>
    <div className="ob-building-lit" style={{ clipPath: `inset(${litInset(lit)} 0 0 0)` }} />
    <div className="ob-door-glow" data-open={open} />
  </div>
);

const WALK_MS = 700;

/** The founder on the street, walking to work: a 2x walk sheet stepped through
 *  its down row. `entering` steps them through the door once they reach it. */
export const FounderSprite = ({
  seed,
  at,
  entering,
}: {
  seed: string;
  at: number;
  entering: boolean;
}) => {
  const assets = useAsync(() => getCharacterAssets(seed), [seed]);
  const [walkedTo, setWalkedTo] = useState(at);
  useEffect(() => {
    if (walkedTo === at) {
      return;
    }
    const timer = window.setTimeout(() => setWalkedTo(at), WALK_MS);
    return () => window.clearTimeout(timer);
  }, [at, walkedTo]);
  if (!assets) {
    return null;
  }
  const walking = walkedTo !== at;
  return (
    <div
      className={cn(
        "ob-sprite",
        walking && "ob-sprite-walk",
        entering && !walking && "ob-sprite-enter",
      )}
      style={{ backgroundImage: `url(${assets.walkSheetDataUrl})`, left: `${at}%` }}
      aria-hidden
    />
  );
};

/** The founder up close, the way a starter is shown before it is picked: the idle down frame. */
export const FounderCloseUp = ({ seed }: { seed: string }) => {
  const assets = useAsync(() => getCharacterAssets(seed), [seed]);
  if (!assets) {
    return <div className="ob-closeup" />;
  }
  return (
    <div
      key={seed}
      className="ob-closeup ob-closeup-founder"
      style={{ backgroundImage: `url(${assets.walkSheetDataUrl})` }}
      aria-hidden
    />
  );
};

/** Chad Runwayson, the VC who owns the building and does the talking. Up close
 *  in the intro, then a passer-by's size out on the street, where the office's
 *  own "…" emote floats over him while he waits on his recruiter. */
export const Narrator = ({
  frame,
  thinking = false,
}: {
  frame: "closeup" | "street";
  thinking?: boolean;
}) => (
  <div
    className={frame === "closeup" ? "ob-closeup ob-narrator" : "ob-sprite ob-narrator-street"}
    aria-hidden
  >
    {thinking ? <span className="ob-emote" /> : null}
  </div>
);

export const TeamParade = ({ hires }: { hires: HireProposal[] }) => (
  <div className="ob-parade px-window grid max-h-[46vh] w-full grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
    {hires.map((h, i) => (
      <div
        key={h.spriteSeed}
        className="px-inset flex items-start gap-2 p-2 text-left"
        style={{ animationDelay: `${i * 180}ms` }}
      >
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
    <div className="ob-meter px-inset w-full max-w-md p-3">
      <span className="text-xs uppercase tracking-wide text-fg-dim">Budget</span>
      <div className="ob-meter-bar">
        <div className="ob-meter-fill" data-tone={toneOf(capUsd)} style={{ width: `${width}%` }} />
      </div>
      <span className="text-sm tabular-nums text-fg">{capUsd === null ? "∞" : `$${capUsd}`}</span>
    </div>
  );
};
