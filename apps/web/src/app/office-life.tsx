"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The landing card doubles as this employee's office: they wander the card,
// sit down at their desk, grab water, and mutter start-up things. All sprites
// are the game's real assets (npc.png = the composed in-game character sheet).

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

type Row = "down" | "left" | "right" | "up" | "sit";
const ROW_Y: Record<Row, number> = { down: 0, left: -64, right: -128, up: -192, sit: -256 };
const SPEED = 42; // px/s
const NPC_W = 32;
const NPC_H = 64;

interface Pose {
  x: number;
  y: number;
  row: Row;
  moving: boolean;
  sitting: boolean;
  ms: number; // transition duration for this leg
  bubble: string | null;
}

function pick<T>(arr: readonly T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function OfficeLife() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<HTMLImageElement>(null);
  const coolerRef = useRef<HTMLImageElement>(null);
  const timerRef = useRef<number | null>(null);
  const poseRef = useRef<Pose>({ x: 60, y: 60, row: "down", moving: false, sitting: false, ms: 0, bubble: null });
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

    const idle = (row: Row, ms: number, bubble: string | null, done: () => void) => {
      setPose({ ...poseRef.current, row, moving: false, sitting: row === "sit", ms: 0, bubble });
      later(ms, done);
    };

    const tick = () => {
      const w = overlay.clientWidth;
      const h = overlay.clientHeight;
      const roll = Math.random();
      if (roll < 0.22) {
        // sit down at the desk for a bit
        const chair = spotIn(deskRef.current, 78, 52);
        if (chair) {
          walk(chair.x, chair.y, () => idle("sit", 3800 + Math.random() * 3200, null, tick));
          return;
        }
      } else if (roll < 0.38) {
        // water break
        const spot = spotIn(coolerRef.current, -4, 8);
        if (spot) {
          walk(spot.x, spot.y, () => idle("up", 2400 + Math.random() * 1600, null, tick));
          return;
        }
      } else if (roll < 0.6) {
        // say something founder-y, then move on
        idle(poseRef.current.row === "sit" ? "down" : poseRef.current.row, 2600, pick(LINES) ?? null, tick);
        return;
      }
      // wander somewhere on the card
      const tx = 8 + Math.random() * Math.max(40, w - NPC_W - 16);
      const ty = 8 + Math.random() * Math.max(40, h - NPC_H - 16);
      walk(tx, ty, () => idle(poseRef.current.row, 700 + Math.random() * 1800, null, tick));
    };

    setPose({ ...poseRef.current, x: 40, y: overlay.clientHeight * 0.4 });
    later(600, tick);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={overlayRef} aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={deskRef}
        src="/office/desk.png"
        alt=""
        width={130}
        height={122}
        className="px-prop"
        style={{ left: 10, top: "20%", zIndex: 2 }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={coolerRef}
        src="/office/cooler.png"
        alt=""
        width={28}
        height={60}
        className="px-prop"
        style={{ right: 12, top: "56%", zIndex: 2 }}
      />
      {pose ? (
        <div
          className={`px-npc ${pose.moving || pose.sitting ? "px-npc-anim" : ""}`}
          style={{
            left: pose.x,
            top: pose.y,
            zIndex: pose.sitting ? 1 : 3,
            transitionDuration: `${pose.ms}ms, ${pose.ms}ms`,
            backgroundPositionY: ROW_Y[pose.row],
            animationDuration: pose.sitting ? "1.4s" : "0.66s",
          }}
        >
          {pose.bubble ? <div className="px-say">{pose.bubble}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
