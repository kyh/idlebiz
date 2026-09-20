import type Phaser from "phaser";
import type { Employee } from "@/shared/domain";

/**
 * Everything the UI and the office scene say to each other, and what each
 * message carries. They share one Phaser emitter; this is its vocabulary, so a
 * renamed message or a changed payload is a compile error on both sides.
 */
export interface OfficeMessages {
  /** UI → scene: a hire walks in through the door. */
  "spawn-employee": Employee;
  /** UI → scene: a released teammate walks out. */
  "despawn-employee": string;
  /** UI → scene: an overlay is up, so the keyboard and clicks are not the game's. */
  "ui-modal": boolean;
  /** UI → scene: a company was just founded; rebuild the room around its team. */
  "company-ready": null;
  /** scene → UI: input is wired, so the current modal state can be replayed. */
  "office-input-ready": null;
  /** scene → UI: the founder walked up to someone. */
  "npc-interact": { employeeId: string };
}

type Message = keyof OfficeMessages;

export const tell = <K extends Message>(
  game: Phaser.Game,
  message: K,
  payload: OfficeMessages[K],
): void => {
  game.events.emit(message, payload);
};

/** Listen for a message; the returned function stops listening. */
export const hear = <K extends Message>(
  game: Phaser.Game,
  message: K,
  heard: (payload: OfficeMessages[K]) => void,
): (() => void) => {
  game.events.on(message, heard);
  return () => {
    game.events.off(message, heard);
  };
};
