/// <reference types="vite/client" />

import type { Game } from "phaser";
import type { AppBridge } from "@/shared/ipc-registry";

declare global {
  interface Window {
    appBridge?: AppBridge;
    /** Dev/test handle to the running Phaser game (set in phaser-game.tsx). */
    __game?: Game;
  }
}

declare module "*.css";
declare module "*.png?url" {
  const url: string;
  export default url;
}
