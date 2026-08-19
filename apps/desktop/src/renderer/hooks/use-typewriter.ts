import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./use-reduced-motion";

const CHARS_PER_TICK = 2;
const TICK_MS = 16;

export interface Typewriter {
  /** The prefix of `text` revealed so far. */
  shown: string;
  done: boolean;
  /** Reveal the rest immediately. */
  skip: () => void;
}

/**
 * Pokémon-style character-by-character reveal.
 *
 * Progress is stored alongside the text it belongs to so a new `text` reads as
 * zero revealed on the very first render — resetting it from an effect would
 * flash one frame of the new line at the old line's length.
 */
export function useTypewriter(text: string): Typewriter {
  const [progress, setProgress] = useState({ text, shown: 0 });
  const reduced = useReducedMotion();
  const timerRef = useRef<number | null>(null);

  const shown = reduced ? text.length : progress.text === text ? progress.shown : 0;

  useEffect(() => {
    if (reduced) return;
    let next = 0;
    const tick = () => {
      next = Math.min(next + CHARS_PER_TICK, text.length);
      setProgress({ text, shown: next });
      timerRef.current = next < text.length ? window.setTimeout(tick, TICK_MS) : null;
    };
    timerRef.current = window.setTimeout(tick, TICK_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [text, reduced]);

  const skip = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setProgress({ text, shown: text.length });
  }, [text]);

  return { shown: text.slice(0, shown), done: shown >= text.length, skip };
}
