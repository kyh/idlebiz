/// <reference types="vite/client" />

import type { Game } from "phaser";

declare global {
  interface Window {
    /** Dev/test handle to the running Phaser game (set in phaser-game.tsx). */
    __game?: Game;
  }
}

declare module "*.css";
declare module "*.png?url" {
  const url: string;
  export default url;
}
