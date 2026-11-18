import { useEffect, useEffectEvent, useRef } from "react";
import { AUTO, Game, Scale } from "phaser";
import type Phaser from "phaser";
import { OfficeScene } from "@/renderer/game/scenes/office-scene";

export const PhaserGame = ({ onGame }: { onGame?: (game: Phaser.Game | null) => void }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const handOff = useEffectEvent((game: Phaser.Game | null) => onGame?.(game));

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const game = new Game({
      audio: { noAudio: true },
      backgroundColor: "#12141c",
      parent: containerRef.current,
      pixelArt: true,
      render: { preserveDrawingBuffer: import.meta.env.DEV },
      roundPixels: true,
      scale: { height: "100%", mode: Scale.RESIZE, width: "100%" },
      type: AUTO,
    });

    game.scene.add("office", OfficeScene, true);
    window.__game = game;
    handOff(game);

    return () => {
      handOff(null);
      game.destroy(true);
      window.__game = undefined;
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
};
