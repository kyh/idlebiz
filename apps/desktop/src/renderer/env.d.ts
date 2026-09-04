/// <reference types="vite/client" />

declare module "*.css";
declare module "*.png?url" {
  const url: string;
  export default url;
}

interface Window {
  appBridge?: import("@/shared/ipc-registry").AppBridge;
  /** Dev/test handle to the running Phaser game (set in phaser-game.tsx). */
  __game?: import("phaser").Game;
}
