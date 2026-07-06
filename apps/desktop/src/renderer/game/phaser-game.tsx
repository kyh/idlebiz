import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { OfficeScene } from "@/renderer/game/scenes/office-scene";

export function PhaserGame({ onGame }: { onGame?: (game: Phaser.Game) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (gameRef.current || !containerRef.current) return; // StrictMode double-mount guard

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
      physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
      scene: [OfficeScene],
    });
    gameRef.current = game;
    // Debug/test handle for CDP probes.
    void Reflect.set(window, "__game", game);
    onGame?.(game);

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
