import { useEffect, useEffectEvent, useRef } from "react";
import Phaser from "phaser";
import { OfficeScene } from "@/renderer/game/scenes/office-scene";

export function PhaserGame({ onGame }: { onGame?: (game: Phaser.Game) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handOff = useEffectEvent((game: Phaser.Game) => onGame?.(game));

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
      scene: [OfficeScene],
    });
    // The CDP handle, set here rather than waiting for the scene: under headless
    // automation the boot stalls before create() and the probe has to kick it.
    // oxlint-disable-next-line eslint/no-underscore-dangle -- the name AGENTS.md documents
    window.__game = game;
    handOff(game);

    return () => {
      game.destroy(true);
      // oxlint-disable-next-line eslint/no-underscore-dangle -- the name AGENTS.md documents
      window.__game = undefined;
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
