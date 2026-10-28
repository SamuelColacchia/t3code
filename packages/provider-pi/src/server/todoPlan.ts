import {
  ProviderDriverKind,
  type NodeId,
  type OrchestrationV2PlanStep,
  type PlanId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  piRecordField as recordField,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");

interface PiTodoTurn {
  readonly turnInput: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThread: { readonly id: ProviderThreadId };
  };
  readonly providerTurn: { readonly id: ProviderTurnId };
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
}

// One plan per turn, like OpenCode; the latest turn's plan is the thread's plan.
const planIds = new WeakMap<PiTodoTurn, PlanId>();

const itemOrdinal = (turn: PiTodoTurn, nativeItemId: string) => {
  const existing = turn.itemOrdinals.get(nativeItemId);
  if (existing !== undefined) return existing;
  const ordinal = turn.nextItemOrdinal++;
  turn.itemOrdinals.set(nativeItemId, ordinal);
  return ordinal;
};

/**
 * OMO's `todo` tool returns the whole list in `result.details.phases`, so each call replaces the
 * plan. The contract has no dropped state; dropped tasks are finished work, marked in the text.
 */
function todoSteps(
  details: unknown,
  stepIdPrefix: string,
): Array<OrchestrationV2PlanStep> | undefined {
  const phases = recordField(details, "phases");
  if (!Array.isArray(phases)) return undefined;
  const tasks = phases.flatMap((phase) => {
    const phaseTasks = recordField(phase, "tasks");
    return Array.isArray(phaseTasks) ? phaseTasks : [];
  });
  return tasks.map((task, index) => {
    const status = recordString(task, "status");
    const content = recordString(task, "content")?.trim() || `Todo ${index + 1}`;
    return {
      id: `${stepIdPrefix}:${index + 1}`,
      text: status === "abandoned" ? `(dropped) ${content}` : content,
      status:
        status === "completed" || status === "abandoned"
          ? "completed"
          : status === "in_progress"
            ? "running"
            : "pending",
    };
  });
}

export const emitPiTodoPlan = Effect.fn("PiAdapter.emitTodoPlan")(function* (
  turn: PiTodoTurn,
  event: PiRpcRecord,
  emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>,
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
) {
  if (recordString(event, "toolName") !== "todo") return;
  const nativeItemId = `${turn.providerTurn.id}:todo`;
  const steps = todoSteps(recordField(event["result"], "details"), nativeItemId);
  if (steps === undefined) return;
  const now = yield* DateTime.now;
  let planId = planIds.get(turn);
  if (planId === undefined) {
    planId = yield* idAllocator.allocate.plan({
      threadId: turn.turnInput.threadId,
      runId: turn.turnInput.runId,
      driver: PI_DRIVER,
    });
    planIds.set(turn, planId);
  }
  const nodeId = idAllocator.derive.nodeFromProviderItem({ driver: PI_DRIVER, nativeItemId });
  const nativeItemRef = { driver: PI_DRIVER, nativeId: nativeItemId, strength: "weak" as const };
  const allCompleted = steps.length > 0 && steps.every((step) => step.status === "completed");
  yield* emit({
    type: "node.updated",
    driver: PI_DRIVER,
    node: {
      id: nodeId,
      threadId: turn.turnInput.threadId,
      runId: turn.turnInput.runId,
      parentNodeId: turn.turnInput.rootNodeId,
      rootNodeId: turn.turnInput.rootNodeId,
      kind: "todo_list",
      status: "completed",
      countsForRun: false,
      providerThreadId: turn.turnInput.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: turn.startedAt,
      completedAt: now,
    },
  });
  yield* emit({
    type: "plan.updated",
    driver: PI_DRIVER,
    plan: {
      id: planId,
      threadId: turn.turnInput.threadId,
      runId: turn.turnInput.runId,
      nodeId,
      kind: "todo_list",
      status: allCompleted ? "completed" : "active",
      steps,
    },
  });
  yield* emit({
    type: "turn_item.updated",
    driver: PI_DRIVER,
    turnItem: {
      id: idAllocator.derive.turnItemFromProviderItem({ driver: PI_DRIVER, nativeItemId }),
      threadId: turn.turnInput.threadId,
      runId: turn.turnInput.runId,
      nodeId,
      providerThreadId: turn.turnInput.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef,
      parentItemId: null,
      ordinal: itemOrdinal(turn, nativeItemId),
      status: "completed",
      title: "Todo list",
      startedAt: turn.startedAt,
      completedAt: now,
      updatedAt: now,
      type: "todo_list",
      planId,
      steps,
    },
  });
});
