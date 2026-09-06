"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

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
const SPEED = 64; // px/s at 1.5x
const NPC_W = 48;
const NPC_H = 96;
// chair seat inside desk.png (natural 52x96, drawn at 1.5x)
const SEAT_X = 39;
const SEAT_Y = 114;

type Point = { x: number; y: number };

interface Pose {
  x: number;
  y: number;
  row: Row;
  moving: boolean;
  sitting: boolean;
  ms: number;
  bubble: string | null;
}

function pick<T>(arr: readonly T[]): T | null {
  return arr[Math.floor(Math.random() * arr.length)] ?? null;
}

function Desk({ ref, raised }: { ref: Ref<HTMLImageElement>; raised: boolean }) {
  return (
    <span className={`px-prop-wrap relative ${raised ? "z-30" : ""}`} aria-hidden>
      <span className="px-ground-shadow" style={{ width: "94%", height: 15 }} />
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
}

function Cooler({ ref }: { ref: Ref<HTMLImageElement> }) {
  return (
    <span className="px-prop-wrap absolute right-4 bottom-[22px]" aria-hidden>
      <span className="px-ground-shadow" style={{ width: "116%", height: 11 }} />
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
}

function ClickMarker({ at }: { at: Point }) {
  return <div className="px-selector" style={{ left: at.x, top: at.y }} />;
}

function Employee({ pose }: { pose: Pose }) {
  return (
    <div
      className="px-npc"
      style={{
        transform: `translate(${pose.x}px, ${pose.y}px)`,
        transitionDuration: `${pose.ms}ms`,
      }}
    >
      <span className="px-ground-shadow" style={{ width: 30, height: 9 }} />
      <div
        className={`px-npc-body ${pose.moving ? "px-npc-anim" : ""}`}
        style={{ backgroundPositionY: ROW_Y[pose.row] }}
      />
      {pose.bubble ? <div className="px-say">{pose.bubble}</div> : null}
    </div>
  );
}

export function OfficeLife({ title }: { title: ReactNode }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<HTMLImageElement>(null);
  const coolerRef = useRef<HTMLImageElement>(null);
  const [pose, setPoseState] = useState<Pose | null>(null);
  const [marker, setMarker] = useState<Point | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    let current: Pose = {
      x: 60,
      y: overlay.clientHeight * 0.35,
      row: "down",
      moving: false,
      sitting: false,
      ms: 0,
      bubble: null,
    };
    let timer: number | null = null;

    const setPose = (next: Pose) => {
      current = next;
      setPoseState(next);
    };

    const later = (ms: number, fn: () => void) => {
      timer = window.setTimeout(fn, ms);
    };

    const spotIn = (el: HTMLElement | null, dx: number, dy: number): Point | null => {
      if (!el) return null;
      const o = overlay.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - o.left + dx, y: r.top - o.top + dy };
    };

    const walk = (tx: number, ty: number, done: () => void) => {
      const dx = tx - current.x;
      const dy = ty - current.y;
      const dist = Math.hypot(dx, dy);
      const row: Row =
        Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
      const ms = Math.max(300, (dist / SPEED) * 1000);
      setPose({ ...current, x: tx, y: ty, row, moving: true, sitting: false, ms, bubble: null });
      later(ms, done);
    };

    const idle = (
      row: Row,
      ms: number,
      opts: { bubble?: string | null; sitting?: boolean },
      done: () => void,
    ) => {
      setPose({
        ...current,
        row,
        moving: false,
        sitting: opts.sitting ?? false,
        ms: 0,
        bubble: opts.bubble ?? null,
      });
      later(ms, done);
    };

    // feet on the chair, so the chair and desk draw over the body
    const sitAtDesk = (): boolean => {
      const seat = spotIn(deskRef.current, SEAT_X - NPC_W / 2, SEAT_Y - (NPC_H - 8));
      if (!seat) return false;
      walk(seat.x, seat.y, () => idle("up", 4200 + Math.random() * 3600, { sitting: true }, tick));
      return true;
    };

    const waterBreak = (): boolean => {
      const spot = spotIn(coolerRef.current, -3, 20);
      if (!spot) return false;
      walk(spot.x, spot.y, () => idle("up", 2400 + Math.random() * 1600, {}, tick));
      return true;
    };

    const mutter = () => {
      idle(current.row, 2600, { bubble: pick(LINES) }, tick);
    };

    const wander = () => {
      const w = overlay.clientWidth;
      const h = overlay.clientHeight;
      const tx = 8 + Math.random() * Math.max(60, w - NPC_W - 16);
      const ty = 8 + Math.random() * Math.max(60, h - NPC_H - 16);
      walk(tx, ty, () =>
        idle(
          current.row,
          1400 + Math.random() * 1800,
          { bubble: Math.random() < 0.4 ? pick(LINES) : null },
          tick,
        ),
      );
    };

    // a prop missing from the DOM turns its routine into a wander
    const tick = () => {
      const roll = Math.random();
      if (roll < 0.25) {
        if (sitAtDesk()) return;
      } else if (roll < 0.4) {
        if (waterBreak()) return;
      } else if (roll < 0.68) {
        mutter();
        return;
      }
      wander();
    };

    // click anywhere non-interactive on the card: the employee reports there,
    // says something corporate, then goes back to their routine
    const cardEl = overlay.closest(".px-window");
    const card = cardEl instanceof HTMLElement ? cardEl : overlay.parentElement;
    const onCardClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest("a, button, [role='button']")) return;
      const o = overlay.getBoundingClientRect();
      const tx = Math.min(Math.max(e.clientX - o.left - NPC_W / 2, 4), o.width - NPC_W - 4);
      const ty = Math.min(Math.max(e.clientY - o.top - (NPC_H - 12), 4), o.height - NPC_H - 4);
      if (timer !== null) window.clearTimeout(timer);
      setMarker({ x: e.clientX - o.left, y: e.clientY - o.top });
      walk(tx, ty, () => {
        setMarker(null);
        idle("down", 2800, { bubble: pick(CORPORATE_LINES) }, () =>
          idle("down", 600 + Math.random() * 900, {}, tick),
        );
      });
    };
    card?.addEventListener("click", onCardClick);

    setPose(current);
    later(600, tick);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
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
}
