import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

/** The most of a workspace's AGENTS.md a run is handed: what codex reads of one (`project_doc_max_bytes`). */
export const TEAM_NOTES_MAX_BYTES = 32 * 1024;

/** What the team keeps for a product, and whether it ran past `TEAM_NOTES_MAX_BYTES` and was cut there. */
export interface TeamNotes {
  text: string;
  cut: boolean;
}

/**
 * `AGENTS.md` at the root of `workspace`, or null when it is missing or empty. Main reads it
 * unsealed, and any run on the product can write it, so it is read only as a plain file of its
 * own: a symlink, or a hard link to a file the seal keeps from runs, is never read through.
 */
export const readTeamNotes = async (workspace: string): Promise<TeamNotes | null> => {
  const file = await open(
    path.join(workspace, "AGENTS.md"),
    // a FIFO would block the open
    // oxlint-disable-next-line no-bitwise -- open(2) takes its flags as bits, and no string names O_NOFOLLOW
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  // none there, or a symlink (ELOOP)
  if (file === null) {
    return null;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      return null;
    }
    const buffer = Buffer.alloc(TEAM_NOTES_MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = new TextDecoder()
      .decode(buffer.subarray(0, Math.min(bytesRead, TEAM_NOTES_MAX_BYTES)))
      .trim();
    return text === "" ? null : { cut: bytesRead > TEAM_NOTES_MAX_BYTES, text };
  } finally {
    await file.close();
  }
};
