"use client";

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

/** The landing card behaves like an app window: grab the titlebar to drag it. */
export function WindowCard({ titlebar, children }: { titlebar: ReactNode; children: ReactNode }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseX: offset.x,
        baseY: offset.y,
      };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // synthetic/secondary pointers can't always be captured — drag still works
      }
    },
    [offset],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setOffset({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  }, []);

  return (
    <div
      className="px-window relative w-full max-w-xl"
      style={{ transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="px-drag"
      >
        {titlebar}
      </div>
      {children}
    </div>
  );
}
