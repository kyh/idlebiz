"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { cn } from "cn";

// Game sprites render at 1.5x.
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

// delivered on arrival when the visitor clicks somewhere on the card
const CORPORATE_LINES = [
  "per my last email",
  "let's circle back",
  "can we take this offline?",
  "great alignment here",
  "I'll action that",
  "quick win!",
  "low-hanging fruit",
  "moving the needle",
  "cascading this downstream",
  "let's double-click on that",
];

type Row = "down" | "left" | "right" | "up";
const ROW_Y = { down: 0, left: -96, right: -192, up: -288 } satisfies Record<Row, number>;
// px/s at 1.5x
const SPEED = 64;
const NPC_W = 48;
const NPC_H = 96;
// chair seat inside desk.png (natural 52x96, drawn at 1.5x)
const SEAT_X = 39;
const SEAT_Y = 114;

interface Point {
  x: number;
  y: number;
}

interface Pose {
  x: number;
  y: number;
  row: Row;
  moving: boolean;
  sitting: boolean;
  ms: number;
  bubble: string | null;
}

const pick = <T,>(arr: readonly T[]): T | null =>
  arr[Math.floor(Math.random() * arr.length)] ?? null;

const rowToward = (dx: number, dy: number): Row => {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx < 0 ? "left" : "right";
  }
  return dy < 0 ? "up" : "down";
};

const Desk = ({ ref, raised }: { ref: Ref<HTMLImageElement>; raised: boolean }) => (
  <span className={cn("px-prop-wrap relative", raised && "z-30")} aria-hidden>
    <span className="px-ground-shadow" style={{ height: 15, width: "94%" }} />
    <Image
      ref={ref}
      src="/office/desk.png"
      alt=""
      width={52}
      height={96}
      unoptimized
      className="px-prop h-[144px] w-auto"
    />
  </span>
);

const Cooler = ({ ref }: { ref: Ref<HTMLImageElement> }) => (
  <span className="px-prop-wrap absolute right-4 bottom-[22px]" aria-hidden>
    <span className="px-ground-shadow" style={{ height: 11, width: "116%" }} />
    <Image
      ref={ref}
      src="/office/cooler.png"
      alt=""
      width={28}
      height={60}
      unoptimized
      className="px-prop h-[90px] w-auto"
    />
  </span>
);

const ClickMarker = ({ at }: { at: Point }) => (
  <div className="px-selector" style={{ left: at.x, top: at.y }} />
);

const Employee = ({ pose }: { pose: Pose }) => (
  <div
    className="px-npc"
    style={{
      transform: `translate(${pose.x}px, ${pose.y}px)`,
      transitionDuration: `${pose.ms}ms`,
    }}
  >
    <span className="px-ground-shadow" style={{ height: 9, width: 30 }} />
    <div
      className={cn("px-npc-body", pose.moving && "px-npc-anim")}
      style={{ backgroundPositionY: ROW_Y[pose.row] }}
    />
    {pose.bubble ? <div className="px-say">{pose.bubble}</div> : null}
  </div>
);

export const OfficeLife = ({ title }: { title: ReactNode }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<HTMLImageElement>(null);
  const coolerRef = useRef<HTMLImageElement>(null);
  const [pose, setPose] = useState<Pose | null>(null);
  const [marker, setMarker] = useState<Point | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }

    let current: Pose = {
      bubble: null,
      moving: false,
      ms: 0,
      row: "down",
      sitting: false,
      x: 60,
      y: overlay.clientHeight * 0.35,
    };
    let timer: number | null = null;

    const applyPose = (next: Pose) => {
      current = next;
      setPose(next);
    };

    const later = (ms: number, fn: () => void) => {
      timer = window.setTimeout(fn, ms);
    };

    const spotIn = (el: HTMLElement | null, dx: number, dy: number): Point | null => {
      if (!el) {
        return null;
      }
      const o = overlay.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - o.left + dx, y: r.top - o.top + dy };
    };

    const walk = (tx: number, ty: number, done: () => void) => {
      const dx = tx - current.x;
      const dy = ty - current.y;
      const dist = Math.hypot(dx, dy);
      const row = rowToward(dx, dy);
      const ms = Math.max(300, (dist / SPEED) * 1000);
      applyPose({ ...current, bubble: null, moving: true, ms, row, sitting: false, x: tx, y: ty });
      later(ms, done);
    };

    const idle = (
      row: Row,
      ms: number,
      opts: { bubble?: string | null; sitting?: boolean },
      done: () => void,
    ) => {
      applyPose({
        ...current,
        bubble: opts.bubble ?? null,
        moving: false,
        ms: 0,
        row,
        sitting: opts.sitting ?? false,
      });
      later(ms, done);
    };

    // feet on the chair, so the chair and desk draw over the body
    const sitAtDesk = (done: () => void): boolean => {
      const seat = spotIn(deskRef.current, SEAT_X - NPC_W / 2, SEAT_Y - (NPC_H - 8));
      if (!seat) {
        return false;
      }
      walk(seat.x, seat.y, () => idle("up", 4200 + Math.random() * 3600, { sitting: true }, done));
      return true;
    };

    const waterBreak = (done: () => void): boolean => {
      const spot = spotIn(coolerRef.current, -3, 20);
      if (!spot) {
        return false;
      }
      walk(spot.x, spot.y, () => idle("up", 2400 + Math.random() * 1600, {}, done));
      return true;
    };

    const mutter = (done: () => void) => {
      idle(current.row, 2600, { bubble: pick(LINES) }, done);
    };

    const wander = (done: () => void) => {
      const w = overlay.clientWidth;
      const h = overlay.clientHeight;
      const tx = 8 + Math.random() * Math.max(60, w - NPC_W - 16);
      const ty = 8 + Math.random() * Math.max(60, h - NPC_H - 16);
      walk(tx, ty, () =>
        idle(
          current.row,
          1400 + Math.random() * 1800,
          { bubble: Math.random() < 0.4 ? pick(LINES) : null },
          done,
        ),
      );
    };

    // a prop missing from the DOM turns its routine into a wander
    const tick = () => {
      const roll = Math.random();
      if (roll < 0.25) {
        if (sitAtDesk(tick)) {
          return;
        }
      } else if (roll < 0.4) {
        if (waterBreak(tick)) {
          return;
        }
      } else if (roll < 0.68) {
        mutter(tick);
        return;
      }
      wander(tick);
    };

    // click anywhere non-interactive on the card: the employee reports there,
    // says something corporate, then goes back to their routine
    const cardEl = overlay.closest(".px-window");
    const card = cardEl instanceof HTMLElement ? cardEl : overlay.parentElement;
    const onCardClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) {
        return;
      }
      if (e.target.closest("a, button, [role='button']")) {
        return;
      }
      const o = overlay.getBoundingClientRect();
      const tx = Math.min(Math.max(e.clientX - o.left - NPC_W / 2, 4), o.width - NPC_W - 4);
      const ty = Math.min(Math.max(e.clientY - o.top - (NPC_H - 12), 4), o.height - NPC_H - 4);
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      setMarker({ x: e.clientX - o.left, y: e.clientY - o.top });
      walk(tx, ty, () => {
        setMarker(null);
        idle("down", 2800, { bubble: pick(CORPORATE_LINES) }, () =>
          idle("down", 600 + Math.random() * 900, {}, tick),
        );
      });
    };
    card?.addEventListener("click", onCardClick);

    applyPose(current);
    later(600, tick);
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      card?.removeEventListener("click", onCardClick);
    };
  }, []);

  return (
    <>
      <div className="grid w-full grid-cols-[78px_1fr_78px] items-center">
        <Desk ref={deskRef} raised={pose?.sitting === true} />
        <div className="flex items-center justify-center">{title}</div>
      </div>
      <Cooler ref={coolerRef} />
      <div
        ref={overlayRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      >
        {marker ? <ClickMarker at={marker} /> : null}
        {pose ? <Employee pose={pose} /> : null}
      </div>
    </>
  );
};
