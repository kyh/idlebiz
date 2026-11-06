import type { Employee } from "@repo/domain/domain";

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
  /**
   * UI → scene: the window holds what the office boots on anew, as a company was just founded or
   * main answered after the window could not reach it; rebuild the room around its team.
   */
  "company-ready": null;
  /**
   * UI → scene: main's events came back after a drop, and its roster and tasks are read again;
   * what was missed meanwhile is lost, so set who is in and what they do by the window's answers.
   */
  resynced: null;
  /** scene → UI: input is wired, so the current modal state can be replayed. */
  "office-input-ready": null;
  /** scene → UI: the founder walked up to someone. */
  "npc-interact": { employeeId: string };
}

type Message = keyof OfficeMessages;

/**
 * All the port touches of a game: the emitter both sides share. A Phaser game
 * is one; holding only this keeps Phaser out of the store.
 */
export interface Office {
  readonly events: {
    emit: <K extends Message>(message: K, payload: OfficeMessages[K]) => void;
    on: <K extends Message>(message: K, heard: (payload: OfficeMessages[K]) => void) => void;
    off: <K extends Message>(message: K, heard: (payload: OfficeMessages[K]) => void) => void;
  };
}

export const tell = <K extends Message>(
  game: Office,
  message: K,
  payload: OfficeMessages[K],
): void => {
  game.events.emit(message, payload);
};

/** Listen for a message; the returned function stops listening. */
export const hear = <K extends Message>(
  game: Office,
  message: K,
  heard: (payload: OfficeMessages[K]) => void,
): (() => void) => {
  game.events.on(message, heard);
  return () => {
    game.events.off(message, heard);
  };
};
