import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

/** The most of a workspace's AGENTS.md a run is handed: what codex reads of one (`project_doc_max_bytes`). */
export const TEAM_NOTES_MAX_BYTES = 32 * 1024;

/** The names codex reads a project's notes under, in its order: the first there is read, the rest never. */
const NOTES_NAMES = ["AGENTS.override.md", "AGENTS.md"];

/** What the team keeps for a product, and whether it ran past `TEAM_NOTES_MAX_BYTES` and was cut there. */
export interface TeamNotes {
  text: string;
  cut: boolean;
}

/** The notes file codex would pick in `workspace`: a file or a link, as codex takes either. */
const pickedIn = async (workspace: string): Promise<string | null> => {
  const found = await Promise.all(
    NOTES_NAMES.map(async (name) => {
      const file = path.join(workspace, name);
      const stats = await lstat(file).catch(() => null);
      return stats !== null && (stats.isFile() || stats.isSymbolicLink()) ? file : null;
    }),
  );
  return found.find((file) => file !== null) ?? null;
};

/**
 * The notes the team keeps at the root of `workspace`, picked as codex picks them, or null when
 * there are none or they are empty. Main reads them unsealed, and any run on the product can
 * write there, so only a file of the workspace's own root is read: through a link only to a file
 * beside it (`AGENTS.md` -> `CLAUDE.md`), never one leading elsewhere, where a folder on the way
 * could be swapped for a link between resolving and opening, nor a hard link to a file the seal
 * keeps from runs.
 */
export const readTeamNotes = async (workspace: string): Promise<TeamNotes | null> => {
  const picked = await pickedIn(workspace);
  const [root, target] = await Promise.all([
    realpath(workspace).catch(() => null),
    picked === null ? null : realpath(picked).catch(() => null),
  ]);
  if (root === null || target === null || path.dirname(target) !== root) {
    return null;
  }
  const file = await open(
    target,
    // a FIFO would block the open
    // oxlint-disable-next-line no-bitwise -- open(2) takes its flags as bits, and no string names O_NOFOLLOW
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  // gone, or made a link since it was resolved (ELOOP)
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
    const cut = bytesRead > TEAM_NOTES_MAX_BYTES;
    // streaming holds back a character the cut split, rather than ending the notes on U+FFFD
    const text = new TextDecoder()
      .decode(buffer.subarray(0, Math.min(bytesRead, TEAM_NOTES_MAX_BYTES)), { stream: cut })
      .trim();
    return text === "" ? null : { cut, text };
  } finally {
    await file.close();
  }
};
