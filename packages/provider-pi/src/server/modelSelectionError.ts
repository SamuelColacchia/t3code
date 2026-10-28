import * as Schema from "effect/Schema";

import { PiRpcError } from "./rpc.ts";

/**
 * Raised when Pi rejects the model or thinking level a turn asked for, such as
 * a model whose context window is smaller than the live context.
 * `makeProviderFailure` shows its message, which carries Pi's reason; the RPC
 * error stays on `cause`.
 */
export class PiModelSelectionError extends Schema.TaggedError<PiModelSelectionError>()(
  "PiModelSelectionError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const reason = this.reason.trim();
    return reason.length === 0
      ? "Pi rejected the model selection for this turn."
      : `Pi rejected the model selection for this turn: ${reason}`;
  }
}

const SELECTION_OPERATIONS = new Set(["set_model", "set_thinking_level"]);
const isPiRpcError = Schema.is(PiRpcError);

/** Timeouts and transport failures pass through unchanged and stay generic. */
export function asPiModelSelectionError(cause: unknown): unknown {
  if (!isPiRpcError(cause) || !SELECTION_OPERATIONS.has(cause.operation)) return cause;
  // `detail` is capped at 200 characters; Pi's full text is on `cause` when it
  // is a string. `makeProviderFailure` bounds and redacts what reaches clients.
  const reason = typeof cause.cause === "string" ? cause.cause : (cause.detail ?? "");
  return new PiModelSelectionError({ reason, cause });
}
