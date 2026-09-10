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
 * RPG-style character-by-character reveal.
 *
 * Progress is stored alongside the text it belongs to so a new `text` reads as
 * zero revealed on the very first render — resetting it from an effect would
 * flash one frame of the new line at the old line's length.
 */
export const useTypewriter = (text: string): Typewriter => {
  const [progress, setProgress] = useState({ shown: 0, text });
  const reduced = useReducedMotion();
  const timerRef = useRef<number | null>(null);

  const revealed = progress.text === text ? progress.shown : 0;
  const shown = reduced ? text.length : revealed;

  useEffect(() => {
    if (reduced) {
      return;
    }
    let next = 0;
    const tick = () => {
      next = Math.min(next + CHARS_PER_TICK, text.length);
      setProgress({ shown: next, text });
      timerRef.current = next < text.length ? window.setTimeout(tick, TICK_MS) : null;
    };
    timerRef.current = window.setTimeout(tick, TICK_MS);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = null;
    };
  }, [text, reduced]);

  const skip = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = null;
    setProgress({ shown: text.length, text });
  }, [text]);

  return { done: shown >= text.length, shown: text.slice(0, shown), skip };
};
