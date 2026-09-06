import { useEffect, useEffectEvent, useRef } from "react";
import Phaser from "phaser";
import type { OfficeLayoutData } from "@/renderer/game/office-layout";
import { OfficeScene, officeSceneData } from "@/renderer/game/scenes/office-scene";

export function PhaserGame({
  layout,
  onGame,
}: {
  layout: OfficeLayoutData;
  onGame?: (game: Phaser.Game | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const handOff = useEffectEvent((game: Phaser.Game | null) => onGame?.(game));
  const firstLayout = useEffectEvent(() => layout);

  useEffect(() => {
    if (!containerRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      backgroundColor: "#12141c",
      pixelArt: true,
      roundPixels: true,
      // dev-only: lets CDP/snapshot tooling capture the WebGL canvas for visual QA
      render: { preserveDrawingBuffer: import.meta.env.DEV },
      audio: { noAudio: true },
      scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
    });
    // the layout rides in as scene data, so the scene has it from init() on
    game.scene.add("office", OfficeScene, true, officeSceneData(firstLayout()));
    gameRef.current = game;
    // The CDP handle, set here rather than waiting for the scene: under headless
    // automation the boot stalls before create() and the probe has to kick it.
    window.__game = game;
    handOff(game);

    return () => {
      handOff(null);
      game.destroy(true);
      gameRef.current = null;
      window.__game = undefined;
    };
  }, []);

  // a new layout while the office is up: the scene rebuilds from it
  useEffect(() => {
    const scene = gameRef.current?.scene.getScene("office");
    if (scene?.scene.isActive()) scene.scene.restart(officeSceneData(layout));
  }, [layout]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
