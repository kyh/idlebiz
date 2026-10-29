import { writeFileSync } from "node:fs";
import path from "node:path";
import { tasksDir } from "../paths";
import { serializeDoc } from "../store/frontmatter";
import * as store from "../store/store";
import { taskToDoc } from "../store/task-codec";
import { hire } from "./save";

/** A hire as `createEmployee` takes one, at the first desk. */
export const recruit = (name: string) => ({ ...hire(name), deskIndex: 0 });

export const launch = (productId: string, landingPath: string | null = null) =>
  store.openBet({
    budgetUsd: 2,
    hypothesis: "a launch post brings visitors",
    landingPath,
    metric: "users",
    productId,
    target: 50,
    title: "Launch post",
    windowHours: 24,
  });

export const firstProduct = () => {
  const [product] = store.listProducts();
  if (!product) {
    throw new Error("no first product");
  }
  return product;
};

/** A task's state, open or shelved as history. */
export const stateOf = (id: string) =>
  (store.getTask(id) ?? store.listShippedTasks().find((t) => t.id === id))?.state;

/** Rewrite an open task on disk as dead of `lastError`, as five failed runs left it; boot reads it. */
export const writeDead = (taskId: string, lastError: string): void => {
  const t = store.getTask(taskId);
  if (!t) {
    throw new Error(`no open task ${taskId}`);
  }
  writeFileSync(
    path.join(tasksDir(), taskId, "TASK.md"),
    serializeDoc(taskToDoc({ ...t, state: { kind: "dead", lastError } })),
  );
};

export const block = (taskId: string, employeeId: string): void => {
  store.claimTask(taskId, employeeId);
  store.lockTaskForRun(taskId, "run-1");
  store.settleTask(taskId, "run-1", {
    ask: { question: "Ship it?", type: "question" },
    kind: "blocked",
    summary: null,
  });
};
