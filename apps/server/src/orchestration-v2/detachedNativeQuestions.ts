import type { OrchestrationV2Command, OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import { PI_PROVIDER } from "@t3tools/provider-pi/server";
import * as Effect from "effect/Effect";

type RuntimeRequestRespond = Extract<
  OrchestrationV2Command,
  { readonly type: "runtime-request.respond" }
>;

// Pi raises non-blocking (waitForAnswer:false) questions with no provider turn so they outlive
// the asking turn; Stop on an idle thread reaches no turn, so it must cancel them explicitly.
export const cancelDetachedNativeQuestions = <E, R>(
  stop: {
    readonly commandId: RuntimeRequestRespond["commandId"];
    readonly threadId: RuntimeRequestRespond["threadId"];
  },
  runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
  respond: (command: RuntimeRequestRespond) => Effect.Effect<unknown, E, R>,
) =>
  Effect.forEach(
    runtimeRequests.filter(
      (request) =>
        request.status === "pending" &&
        request.kind === "user_input" &&
        request.providerTurnId === null &&
        request.responseCapability.type === "live" &&
        request.nativeRequestRef?.driver === PI_PROVIDER,
    ),
    (request) =>
      respond({
        type: "runtime-request.respond",
        commandId: stop.commandId,
        threadId: stop.threadId,
        requestId: request.id,
        decision: "cancel",
      }),
    { discard: true },
  );
