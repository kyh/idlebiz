import type { Task } from "@repo/domain/domain";
import { serializeDoc } from "../store/frontmatter";
import { taskToDoc } from "../store/task-codec";

/** `task`'s TASK.md, as the store writes it. */
export const serializeTask = (task: Task) => serializeDoc(taskToDoc(task));
