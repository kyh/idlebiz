import * as store from "./store/store";
import { postToRoom, refuseHeldKey, settleOrderCard } from "./company-actions";
import { stripeInTestMode } from "./metrics";
import {
  actionAnswer,
  approvalAnswer,
  founderPing,
  integrationConnectedAnswer,
  standingApprovalNews,
  standingSignOffNews,
} from "./prompts/briefs";
import type { TaskBrief } from "./prompts/briefs";
import { report } from "./lib/report";
import { RefusalError } from "./refusal";
import type { Scheduler } from "./scheduler";
import type { VercelConnection } from "./vercel-connect";
import { resolveMentions, taskIn } from "@repo/domain/domain";
import type { HoldRuleId } from "@repo/domain/hold-rules";
import type { ActionReply, IntegrationAsk, IntegrationKind } from "@repo/domain/domain";

/** The scheduler's doors for new work: queue a task that exists, or file one and queue it. */
type Queue = Pick<Scheduler, "enqueue" | "file">;

export const founderActions = (queue: Queue) => {
  const assign = (taskId: string, employeeId: string) => {
    const queued = queue.enqueue(taskId, employeeId);

    if (!queued) {
      throw new RefusalError("task is not assignable");
    }

    return queued;
  };

  const wakeEmployee = (employeeId: string, brief: TaskBrief) => {
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

  const founderMessage = (text: string) => {
    refuseHeldKey(text);
    postToRoom({ kind: "founder" }, text);

    for (const employeeId of resolveMentions(text, store.listEmployees())) {
      wakeEmployee(employeeId, founderPing(text));
    }
  };

  const directEmployee = (employeeId: string, instruction: string) => {
    const emp = store.getEmployee(employeeId);

    if (!emp) {
      throw new RefusalError(`no employee ${employeeId}`);
    }

    refuseHeldKey(instruction);
    postToRoom({ kind: "founder" }, `@${emp.id} ${instruction}`, emp.id);
    wakeEmployee(employeeId, founderPing(instruction));
  };

  const resumeBlocked = (taskId: string, answer: string, whenNotBlocked: string) => {
    refuseHeldKey(answer);
    const continuation = store.resolveBlockedWithAnswer(taskId, answer);

    if (!continuation || !continuation.assigneeId) {
      throw new RefusalError(whenNotBlocked);
    }

    return assign(continuation.id, continuation.assigneeId);
  };

  const answerQuestion = (taskId: string, answer: string) =>
    resumeBlocked(taskId, answer, "task is not awaiting an answer");

  const resolveAction = (taskId: string, reply: ActionReply) => {
    const task = store.getTask(taskId);

    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "action") {
      throw new RefusalError("task is not awaiting an action");
    }

    if (task.origin === "order") {
      return settleOrderCard(taskId, reply);
    }

    return resumeBlocked(taskId, actionAnswer(reply), "could not resume the task");
  };

  const resolveApproval = (taskId: string, approved: boolean) => {
    const task = store.getTask(taskId);

    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "approval") {
      throw new RefusalError("task is not awaiting an approval");
    }

    const { ask } = task.state;
    const continuation = store.resolveBlockedWithAnswer(taskId, approvalAnswer(approved, ask));

    if (!continuation?.assigneeId) {
      throw new RefusalError("could not resume the task");
    }

    if (approved) {
      store.grantApproval(continuation.id, ask.command);
    }

    return assign(continuation.id, continuation.assigneeId);
  };

  const answerStanding = () => {
    const company = store.getCompany();

    if (!company || company.standingSignOffs.length === 0) {
      return;
    }

    for (const task of store.listOpenTasks().filter(taskIn("blocked"))) {
      const { ask } = task.state;

      if (ask.type !== "approval" || !company.standingSignOffs.includes(ask.rule)) {
        continue;
      }

      try {
        resolveApproval(task.id, true);
        postToRoom({ kind: "office" }, standingApprovalNews(ask.command));
      } catch (error) {
        report(`standing sign-off on ${task.id}`, error);
      }
    }
  };

  const setStandingSignOff = (rule: HoldRuleId, on: boolean) => {
    const before = store.requireCompany().standingSignOffs.includes(rule);
    const company = store.setStandingSignOff(rule, on);

    if (before !== on) {
      postToRoom({ kind: "office" }, standingSignOffNews(rule, on));
      answerStanding();
    }

    return company;
  };

  const resumeAsks = (answers: (ask: IntegrationAsk) => boolean) => {
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

  const resumeIntegrationAsks = (kind: Exclude<IntegrationKind, "vercel">) => {
    if (kind === "stripe" && stripeInTestMode()) {
      return;
    }

    resumeAsks((ask) => ask.integration === kind);
  };

  const resumeVercelAsks = (connection: VercelConnection) => {
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
    answerStanding,
    assign,
    directEmployee,
    founderMessage,
    resolveAction,
    resolveApproval,
    resumeIntegrationAsks,
    resumeVercelAsks,
    setStandingSignOff,
  };
};

export type FounderActions = ReturnType<typeof founderActions>;
