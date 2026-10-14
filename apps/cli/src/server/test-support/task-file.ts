import type { Task } from "@repo/domain/domain";
import { serializeDoc } from "../store/frontmatter";
import { taskToDoc } from "../store/task-codec";

// `idlebiz/task-file`, for the e2e suite, which plants tasks in a save before main loads it: through
// the store's own codec, so a change to TASK.md's format cannot leave it planting files boot skips.

/** `task`'s TASK.md, as the store writes it. */
export const serializeTask = (task: Task): string => serializeDoc(taskToDoc(task));
