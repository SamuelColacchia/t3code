import type {
  ProviderDriverKind,
  OrchestrationV2ExecutionNode,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { piRecordString as recordString, type PiRpcRecord } from "./rpc.ts";

// OMO/senpi send method "question" only to clients that declare the capability through the
// provider instance env `SENPI_RPC_CLIENT_CAPABILITIES=question`; stock pi never sends it.
export const PI_QUESTION_METHOD = "question";

interface PiQuestionPrompt {
  readonly nativeRequestId: string;
  readonly method: string;
  expirationFiber: Fiber.Fiber<void> | null;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

const isRecord = (value: unknown): value is PiRpcRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonBlank = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value.trim().length > 0);

/** `waitForAnswer: false` questions outlive their turn; senpi delivers a late answer as a follow-up message. */
export const isDetachedPiQuestion = (event: PiRpcRecord) =>
  event["method"] === PI_QUESTION_METHOD && event["waitForAnswer"] === false;

export function piQuestions(event: PiRpcRecord): Array<OrchestrationV2UserInputQuestion> {
  const questions = Array.isArray(event["questions"]) ? event["questions"] : [];
  return questions.filter(isRecord).flatMap((question) => {
    const id = nonBlank(recordString(question, "id"));
    if (id === undefined) return [];
    const header = nonBlank(recordString(question, "header")) ?? "Question";
    const options = Array.isArray(question["options"]) ? question["options"] : [];
    return [
      {
        id,
        header,
        question: nonBlank(recordString(question, "question")) ?? header,
        options: options.filter(isRecord).flatMap((option) => {
          const label = nonBlank(recordString(option, "label"));
          if (label === undefined) return [];
          return [{ label, description: nonBlank(recordString(option, "description")) ?? label }];
        }),
        multiSelect: question["multiSelect"] === true,
        allowCustomAnswer: true,
      },
    ];
  });
}

export const piQuestionTitle = (event: PiRpcRecord) =>
  piQuestions(event)
    .map((question) => question.header)
    .join(", ");

export function piQuestionResponse(
  turnItem: OrchestrationV2TurnItem,
  answers: Record<string, unknown> | undefined,
): PiRpcRecord {
  const questions = turnItem.type === "user_input_request" ? turnItem.questions : [];
  const mapped: Record<string, { selected: Array<string>; text?: string }> = {};
  for (const question of questions) {
    const answer = answers?.[question.id];
    const labels = new Set(question.options.map((option) => option.value ?? option.label));
    if (Array.isArray(answer)) {
      const selected = answer.filter((entry): entry is string => typeof entry === "string");
      if (selected.length > 0) mapped[question.id] = { selected };
    } else if (typeof answer === "string" && answer.trim().length > 0) {
      mapped[question.id] = labels.has(answer)
        ? { selected: [answer] }
        : { selected: [], text: answer };
    }
  }
  return Object.keys(mapped).length === 0 ? { cancelled: true } : { answers: mapped };
}

const closeResolvedPiQuestion = Effect.fn("PiAdapter.closeResolvedPiQuestion")(function* (
  event: PiRpcRecord,
  prompts: ReadonlyArray<Map<string, PiQuestionPrompt>>,
  driver: ProviderDriverKind,
  emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>,
) {
  const nativeRequestId = recordString(event, "id");
  for (const map of prompts) {
    for (const [requestId, pending] of map) {
      if (pending.method !== PI_QUESTION_METHOD || pending.nativeRequestId !== nativeRequestId)
        continue;
      map.delete(requestId);
      if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
      const outcome = recordString(event, "outcome");
      const answered = outcome === "answered" || outcome === "comment-submitted";
      const resolvedAt = yield* DateTime.now;
      pending.runtimeRequest = {
        ...pending.runtimeRequest,
        status: answered ? "resolved" : outcome === "timed_out" ? "expired" : "cancelled",
        resolvedAt,
      };
      yield* emit({
        type: "runtime_request.updated",
        driver,
        threadId: pending.node.threadId,
        runtimeRequest: pending.runtimeRequest,
      });
      const status = answered ? "completed" : "cancelled";
      yield* emit({
        type: "node.updated",
        driver,
        node: { ...pending.node, status, completedAt: resolvedAt },
      });
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: { ...pending.turnItem, status, completedAt: resolvedAt, updatedAt: resolvedAt },
      });
      return;
    }
  }
});

const cancelDetachedPiQuestions = Effect.fn("PiAdapter.cancelDetachedPiQuestions")(function* <P>(
  pending: Map<string, P>,
  cancel: (prompt: P, resolvedAt: DateTime.Utc) => Effect.Effect<void>,
) {
  const prompts = Array.from(pending.values());
  pending.clear();
  const resolvedAt = yield* DateTime.now;
  yield* Effect.forEach(prompts, (prompt) => cancel(prompt, resolvedAt), { discard: true });
});

export const piPromptClosedStatus = (
  pending: { readonly method: string },
  response: PiRpcRecord,
) =>
  pending.method === PI_QUESTION_METHOD && response["cancelled"] === true
    ? "cancelled"
    : "completed";

export class PiNativeQuestions<P extends PiQuestionPrompt> {
  readonly pendingNativeQuestions = new Map<string, P>();

  // T3 dismisses a turn's pending native questions when the turn completes; a detached
  // question is raised turn-less, like a dialog shown before any turn, so it stays answerable.
  turnFor<T>(event: PiRpcRecord, activeTurn: T | null): T | null {
    return isDetachedPiQuestion(event) ? null : activeTurn;
  }

  promptsFor(event: PiRpcRecord, turnScoped: Map<string, P>): Map<string, P> {
    return isDetachedPiQuestion(event) ? this.pendingNativeQuestions : turnScoped;
  }

  refuseUnusable<E>(
    event: PiRpcRecord,
    nativeRequestId: string,
    send: (record: PiRpcRecord) => Effect.Effect<void, E>,
  ): Effect.Effect<boolean, E> {
    if (event["method"] !== PI_QUESTION_METHOD || piQuestions(event).length > 0)
      return Effect.succeed(false);
    return send({ type: "extension_ui_response", id: nativeRequestId, cancelled: true }).pipe(
      Effect.as(true),
    );
  }

  closeResolved(
    event: PiRpcRecord,
    turnScoped: Map<string, P>,
    driver: ProviderDriverKind,
    emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>,
  ) {
    return closeResolvedPiQuestion(event, [turnScoped, this.pendingNativeQuestions], driver, emit);
  }

  cancelDetached(cancel: (prompt: P, resolvedAt: DateTime.Utc) => Effect.Effect<void>) {
    return cancelDetachedPiQuestions(this.pendingNativeQuestions, cancel);
  }
}
