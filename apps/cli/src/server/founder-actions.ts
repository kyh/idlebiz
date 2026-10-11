// What the founder hands the team from the page: a word in the room, a request to one employee, an
// answer, a sign-off, an assignment, and a connection that resumes the work waiting on it. Each files
// or queues work through the scheduler, which only runs it; a change everyone should hear about
// still goes through company-actions.

import * as store from "./store/store";
import { postToRoom, refuseHeldKey, settleOrderCard } from "./company-actions";
import { stripeInTestMode } from "./metrics";
import {
  actionAnswer,
  approvalAnswer,
  founderPing,
  integrationConnectedAnswer,
} from "./prompts/briefs";
import type { TaskBrief } from "./prompts/briefs";
import { RefusalError } from "./refusal";
import type { createScheduler } from "./scheduler";
import type { VercelConnection } from "./vercel-connect";
import { resolveMentions } from "@repo/domain/domain";
import type { ActionReply, IntegrationAsk, IntegrationKind, Task } from "@repo/domain/domain";

/** The scheduler's doors for new work: queue a task that exists, or file one and queue it. */
type Queue = Pick<ReturnType<typeof createScheduler>, "enqueue" | "file">;

export const founderActions = (queue: Queue) => {
  const assign = (taskId: string, employeeId: string): Task => {
    const queued = queue.enqueue(taskId, employeeId);
    if (!queued) {
      throw new RefusalError("task is not assignable");
    }
    return queued;
  };

  /**
   * Coalesce identical requests still waiting for the same employee. Filed even at the budget
   * cap, as `enqueue` claims: the founder's word waits for the cap to be raised, never lost.
   */
  const wakeEmployee = (employeeId: string, brief: TaskBrief): void => {
    const emp = store.getEmployee(employeeId);
    if (!emp) {
      return;
    }
    const waiting = store
      .openTasksFor(employeeId)
      .some(
        (t) =>
          t.description === brief.description &&
          (t.state.kind === "queued" || t.state.kind === "todo"),
      );
    if (!waiting) {
      queue.file(emp, brief, {
        origin: "founder",
        priority: "high",
        productId: store.productOfEmployee(emp.id)?.id ?? null,
      });
    }
  };

  /** Whole-token @slug or @first-name mentions wake the addressed employees. */
  const founderMessage = (text: string): void => {
    refuseHeldKey(text);
    postToRoom({ kind: "founder" }, text);
    for (const employeeId of resolveMentions(text, store.listEmployees())) {
      wakeEmployee(employeeId, founderPing(text));
    }
  };

  /** Direct requests wake the employee without relying on mention parsing. */
  const directEmployee = (employeeId: string, instruction: string): void => {
    const emp = store.getEmployee(employeeId);
    if (!emp) {
      throw new RefusalError(`no employee ${employeeId}`);
    }
    refuseHeldKey(instruction);
    postToRoom({ kind: "founder" }, `@${emp.id} ${instruction}`, emp.id);
    wakeEmployee(employeeId, founderPing(instruction));
  };

  const resumeBlocked = (taskId: string, answer: string, whenNotBlocked: string): Task => {
    refuseHeldKey(answer);
    const continuation = store.resolveBlockedWithAnswer(taskId, answer);
    if (!continuation || !continuation.assigneeId) {
      throw new RefusalError(whenNotBlocked);
    }
    return assign(continuation.id, continuation.assigneeId);
  };

  const answerQuestion = (taskId: string, answer: string): Task =>
    resumeBlocked(taskId, answer, "task is not awaiting an answer");

  const resolveAction = (taskId: string, reply: ActionReply): Task => {
    const task = store.getTask(taskId);
    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "action") {
      throw new RefusalError("task is not awaiting an action");
    }
    if (task.origin === "order") {
      return settleOrderCard(taskId, reply);
    }
    return resumeBlocked(taskId, actionAnswer(reply), "could not resume the task");
  };

  const resolveApproval = (taskId: string, approved: boolean): Task => {
    const task = store.getTask(taskId);
    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "approval") {
      throw new RefusalError("task is not awaiting an approval");
    }
    const { command } = task.state.ask;
    const continuation = store.resolveBlockedWithAnswer(taskId, approvalAnswer(approved, command));
    if (!continuation?.assigneeId) {
      throw new RefusalError("could not resume the task");
    }
    // Record before the continuation can start: its retry hits the hook again,
    // and must find the sign-off already there.
    if (approved) {
      store.grantApproval(continuation.id, command);
    }
    return assign(continuation.id, continuation.assigneeId);
  };

  const resumeAsks = (answers: (ask: IntegrationAsk) => boolean): void => {
    if (!store.getCompany()) {
      return;
    }
    for (const task of store.listOpenTasks()) {
      const st = task.state;
      if (st.kind !== "blocked" || st.ask.type !== "integration") {
        continue;
      }
      if (!answers(st.ask)) {
        continue;
      }
      const continuation = store.resolveBlockedWithAnswer(
        task.id,
        integrationConnectedAnswer(st.ask.integration),
      );
      if (continuation?.assigneeId) {
        queue.enqueue(continuation.id, continuation.assigneeId);
      }
    }
  };

  /** Resume every ask waiting on `kind`, which the founder has just connected. */
  const resumeIntegrationAsks = (kind: Exclude<IntegrationKind, "vercel">): void => {
    // A test-mode key counts no money: a run resumed on it for revenue finds the same test mode
    // and asks again.
    if (kind === "stripe" && stripeInTestMode()) {
      return;
    }
    resumeAsks((ask) => ask.integration === kind);
  };

  /**
   * Resume the Vercel asks `connection` answers: every one for the first token, else those about
   * its product and any that named none. Another product's ask waits on that product's binding.
   */
  const resumeVercelAsks = (connection: VercelConnection): void => {
    resumeAsks(
      (ask) =>
        ask.integration === "vercel" &&
        (connection.kind === "token" ||
          ask.productId === null ||
          ask.productId === connection.productId),
    );
  };

  return {
    answerQuestion,
    assign,
    directEmployee,
    founderMessage,
    resolveAction,
    resolveApproval,
    resumeIntegrationAsks,
    resumeVercelAsks,
  };
};

export type FounderActions = ReturnType<typeof founderActions>;
