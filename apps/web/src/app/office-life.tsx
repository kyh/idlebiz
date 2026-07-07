"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// The landing card doubles as this employee's office. The desk sits top-left
// in the title row (grid cell — it reserves space, never covers copy), the
// cooler is pinned to the card's bottom-right corner, and the employee roams
// the whole card: sits at the desk, takes water breaks, mutters founder
// things. All sprites are the game's real assets at 1.5x.

const LINES = [
  "ship it",
  "standup in 5",
  "deploying…",
  "inbox zero!",
  "LGTM",
  "brb, coffee",
  "who broke CI?",
  "big launch today",
  "just one more fix",
];

type Row = "down" | "left" | "right" | "up";
const ROW_Y: Record<Row, number> = { down: 0, left: -96, right: -192, up: -288 };
const SPEED = 64; // px/s at 1.5x
const NPC_W = 48;
const NPC_H = 96;
// chair seat inside desk.png (natural 52x96, drawn at 1.5x)
const SEAT_X = 39;
const SEAT_Y = 114;

interface Pose {
  x: number;
  y: number;
  row: Row;
  moving: boolean;
  sitting: boolean;
  ms: number;
  bubble: string | null;
}

function pick<T>(arr: readonly T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function OfficeLife({ title }: { title: ReactNode }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<HTMLImageElement>(null);
  const coolerRef = useRef<HTMLImageElement>(null);
  const timerRef = useRef<number | null>(null);
  const poseRef = useRef<Pose>({ x: 70, y: 70, row: "down", moving: false, sitting: false, ms: 0, bubble: null });
  const [pose, setPoseState] = useState<Pose | null>(null);

  const setPose = useCallback((next: Pose) => {
    poseRef.current = next;
    setPoseState(next);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    const later = (ms: number, fn: () => void) => {
      timerRef.current = window.setTimeout(fn, ms);
    };

    const spotIn = (el: HTMLElement | null, dx: number, dy: number): { x: number; y: number } | null => {
      if (!el) return null;
      const o = overlay.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - o.left + dx, y: r.top - o.top + dy };
    };

    const walk = (tx: number, ty: number, done: () => void) => {
      const p = poseRef.current;
      const dx = tx - p.x;
      const dy = ty - p.y;
      const dist = Math.hypot(dx, dy);
      const row: Row = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
      const ms = Math.max(300, (dist / SPEED) * 1000);
      setPose({ ...p, x: tx, y: ty, row, moving: true, sitting: false, ms, bubble: null });
      later(ms, done);
    };

    const idle = (row: Row, ms: number, opts: { bubble?: string | null; sitting?: boolean }, done: () => void) => {
      setPose({
        ...poseRef.current,
        row,
        moving: false,
        sitting: opts.sitting ?? false,
        ms: 0,
        bubble: opts.bubble ?? null,
      });
      later(ms, done);
    };

    const tick = () => {
      const w = overlay.clientWidth;
      const h = overlay.clientHeight;
      const roll = Math.random();
      if (roll < 0.25) {
        // sit down at the desk: feet on the chair, chair + desk drawn over
        const seat = spotIn(deskRef.current, SEAT_X - NPC_W / 2, SEAT_Y - (NPC_H - 8));
        if (seat) {
          walk(seat.x, seat.y, () => idle("up", 4200 + Math.random() * 3600, { sitting: true }, tick));
          return;
        }
      } else if (roll < 0.4) {
        // water break
        const spot = spotIn(coolerRef.current, -3, 20);
        if (spot) {
          walk(spot.x, spot.y, () => idle("up", 2400 + Math.random() * 1600, {}, tick));
          return;
        }
      } else if (roll < 0.68) {
        // say something founder-y, then move on
        idle(poseRef.current.row, 2600, { bubble: pick(LINES) ?? null }, tick);
        return;
      }
      // wander somewhere on the card (often muttering on arrival)
      const tx = 8 + Math.random() * Math.max(60, w - NPC_W - 16);
      const ty = 8 + Math.random() * Math.max(60, h - NPC_H - 16);
      walk(tx, ty, () =>
        idle(
          poseRef.current.row,
          1400 + Math.random() * 1800,
          { bubble: Math.random() < 0.4 ? (pick(LINES) ?? null) : null },
          tick,
        ),
      );
    };

    setPose({ ...poseRef.current, x: 60, y: overlay.clientHeight * 0.35 });
    later(600, tick);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* title row: desk top-left in its own grid cell, title centered */}
      <div className="grid w-full grid-cols-[auto_1fr_auto] items-start" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={deskRef}
          src="/office/desk.png"
          alt=""
          width={52}
          height={96}
          className={`px-prop h-[144px] w-auto ${pose?.sitting ? "relative z-30" : ""}`}
        />
        <div className="flex items-center justify-center pt-4">{title}</div>
        <div className="w-[78px]" />
      </div>
      {/* cooler pinned to the card's bottom-right corner */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={coolerRef}
        src="/office/cooler.png"
        alt=""
        width={28}
        height={60}
        className="px-prop absolute right-3 bottom-3 h-[90px] w-auto"
        aria-hidden
      />
      {/* the employee roams the whole card */}
      <div ref={overlayRef} aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
        {pose ? (
          <div
            className={`px-npc ${pose.moving ? "px-npc-anim" : ""}`}
            style={{
              left: pose.x,
              top: pose.y,
              transitionDuration: `${pose.ms}ms, ${pose.ms}ms`,
              backgroundPositionY: ROW_Y[pose.row],
            }}
          >
            {pose.bubble ? <div className="px-say">{pose.bubble}</div> : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
