/// <reference lib="dom" />

import type { Game } from "phaser";

declare global {
  interface Window {
    /** Dev/test handle to the running Phaser game (set in phaser-game.tsx). */
    __game?: Game | undefined;
  }
}
