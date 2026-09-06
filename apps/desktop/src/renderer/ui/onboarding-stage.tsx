import { useEffect, useState } from "react";
import { bridge } from "@/renderer/bridge";
import { useAsync } from "@/renderer/hooks/use-async";
import { Portrait } from "@/renderer/ui/portrait";
import type { HireProposal } from "@/shared/ipc-registry";

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

export function NightSky() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div className="ob-sky" />
      {STARS.map(([x, y], i) => (
        <span
          key={`${x}-${y}`}
          className="ob-star"
          style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${(i * 370) % 2400}ms` }}
        />
      ))}
    </div>
  );
}

export const FLOORS = 7;
const WINDOWS = 6;

export function Building({ lit, open }: { lit: number; open: boolean }) {
  return (
    <div className="ob-building" aria-hidden>
      <div className="ob-roof" />
      {Array.from({ length: FLOORS }, (_, i) => {
        const floor = FLOORS - 1 - i;
        return (
          <div key={floor} className="ob-floor">
            {Array.from({ length: WINDOWS }, (_, w) => (
              <span
                key={w}
                className="ob-window"
                data-lit={floor < lit}
                style={{ animationDelay: `${w * 60}ms` }}
              />
            ))}
          </div>
        );
      })}
      <div className="ob-door" data-open={open} />
    </div>
  );
}

const WALK_MS = 700;

export function FounderSprite({ seed, at }: { seed: string; at: number }) {
  const assets = useAsync(() => bridge().composeCharacter({ seed }), [seed]);
  const [walkedTo, setWalkedTo] = useState(at);
  useEffect(() => {
    if (walkedTo === at) return;
    const timer = window.setTimeout(() => setWalkedTo(at), WALK_MS);
    return () => window.clearTimeout(timer);
  }, [at, walkedTo]);
  if (!assets) return null;
  const walking = walkedTo !== at;
  return (
    <div
      className={walking ? "ob-sprite ob-sprite-walk" : "ob-sprite"}
      style={{ left: `${at}%`, backgroundImage: `url(${assets.walkSheetDataUrl})` }}
      aria-hidden
    />
  );
}

/** One of the office's own emotes: "!" for an arrival, "…" for waiting. */
export function Emote({ frame, className = "" }: { frame: 0 | 1; className?: string }) {
  return <span className={`ob-emote ${className}`} data-frame={frame} aria-hidden />;
}

export function TeamParade({ hires }: { hires: HireProposal[] }) {
  return (
    <div className="ob-parade px-window grid max-h-[46vh] w-full grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
      {hires.map((h, i) => (
        <div
          key={h.spriteSeed}
          className="px-inset flex items-start gap-2 p-2 text-left"
          style={{ animationDelay: `${i * 180}ms` }}
        >
          <Portrait seed={h.spriteSeed} size="sm" />
          <span className="min-w-0">
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

/** The biggest cap on offer; the bar is full there. */
const METER_FULL_USD = 50;

type Tone = "tight" | "mid" | "open" | "infinite";
const toneOf = (capUsd: number | null): Tone =>
  capUsd === null ? "infinite" : capUsd <= 5 ? "tight" : capUsd <= 20 ? "mid" : "open";

export function BudgetMeter({ capUsd }: { capUsd: number | null }) {
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
}
