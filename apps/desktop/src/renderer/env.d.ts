// The window's DOM, on tsconfig.page.json's ES2023 ceiling: a `lib` in tsconfig.web.json would
// replace that ceiling, not add to it.
/// <reference lib="dom" />

import type { Game } from "phaser";

declare global {
  interface Window {
    /** Dev/test handle to the running Phaser game (set in phaser-game.tsx). */
    __game?: Game | undefined;
  }
}
