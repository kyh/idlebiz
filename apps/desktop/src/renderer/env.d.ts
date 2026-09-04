/// <reference types="vite/client" />

declare module "*.css";
declare module "*.png?url" {
  const url: string;
  export default url;
}

/** Dev/test probes into the running office scene, for CDP-driven checks. */
interface OfficeDebug {
  bodyBlockedAt: (x: number, y: number) => boolean;
  solidAtPx: (x: number, y: number) => boolean;
  snapshot: () => {
    camera: { x: number; y: number; zoom: number };
    objects: number;
    player: { x: number | null; y: number | null };
    door: import("@/shared/office-layout-schema").PixelPoint;
    seats: number;
    world: { h: number; w: number };
  };
  /** Where a step of `delta` from `start` actually lands; null with no player. */
  probeMove: (
    start: import("@/shared/office-layout-schema").PixelPoint,
    delta: import("@/shared/office-layout-schema").PixelPoint,
  ) => { x: number; y: number } | null;
}

interface Window {
  appBridge?: import("@/shared/ipc-registry").AppBridge;
  /** Dev/test handle to the running Phaser game (set in phaser-game.tsx). */
  __game?: import("phaser").Game;
  /** Set by the office scene while it is up. */
  __officeDebug?: OfficeDebug;
}
