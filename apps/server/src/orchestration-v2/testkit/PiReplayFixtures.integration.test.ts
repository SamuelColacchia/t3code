import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { PiOrchestratorReplayHarness } from "../Adapters/PiAdapterV2.testkit.ts";
import { piCompactionInput } from "./fixtures/pi_compaction/input.ts";
import { PI_MODEL_SELECTION, projectionFor } from "./fixtures/shared.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Pi replay fixtures", () => {
  itRunsReplayFixtures("pi", (input) =>
    runReplayFixture({ ...input, harness: PiOrchestratorReplayHarness }),
  );
});

describe("Pi native questions through OrchestratorV2", () => {
  const scenario = "pi_native_question";
  const question = {
    type: "extension_ui_request",
    id: "native-question-later",
    method: "question",
    requestId: "toolu_native_question",
    toolCallId: "toolu_native_question",
    waitForAnswer: false,
    questions: [
      {
        id: "q1",
        header: "Color",
        question: "Which color?",
        multiSelect: false,
        options: [
          { label: "Red", description: "Warm" },
          { label: "Blue", description: "Cool" },
        ],
      },
      {
        id: "q2",
        header: "Toppings",
        question: "Which toppings?",
        multiSelect: true,
        options: [
          { label: "Cheese", description: "Dairy" },
          { label: "Ham", description: "Meat" },
        ],
      },
    ],
    timeout: 86_400_000,
    askedAtMs: 1_767_225_600_500,
    deadlineAtMs: 1_767_312_000_500,
    remainingMs: 86_400_000,
  };

  // Reuses the first recorded pi_compaction turn; the non-blocking question is asked mid-turn
  // and settled only after that turn has completed.
  const withNativeQuestion =
    (name: string, settle: ReadonlyArray<ProviderReplayTranscript["entries"][number]>) =>
    (recorded: ProviderReplayTranscript): ProviderReplayTranscript => {
      const renamed = JSON.parse(
        JSON.stringify(recorded).replaceAll(
          "Replay fixture: pi_compaction",
          `Replay fixture: ${name}`,
        ),
      ) as ProviderReplayTranscript;
      const agentStart = renamed.entries.findIndex(
        (entry) => entry.type === "emit_inbound" && entry.label === "agent_start",
      );
      const firstTurnEnd = renamed.entries.findIndex(
        (entry) => entry.type === "emit_inbound" && entry.label === "response:get_session_stats",
      );
      return {
        ...renamed,
        scenario: name,
        entries: [
          ...renamed.entries.slice(0, agentStart + 1),
          { type: "emit_inbound", label: "extension_ui_request:question", frame: question },
          ...renamed.entries.slice(agentStart + 1, firstTurnEnd + 1),
          ...settle,
        ],
      };
    };

  const questionResolved = (outcome: string, answers: Record<string, unknown>) => ({
    type: "emit_inbound" as const,
    label: "question_resolved",
    frame: {
      type: "question_resolved",
      id: question.id,
      requestId: question.requestId,
      toolCallId: question.toolCallId,
      outcome,
      ...(outcome === "answered" ? { resolvedBy: "rpc_connection" } : {}),
      answers,
      unanswered: outcome === "answered" ? [] : ["q1", "q2"],
    },
  });

  const answered = { q1: { selected: ["Red"] }, q2: { selected: ["Cheese", "Ham"] } };

  it.effect("keeps a non-blocking question answerable after its turn completes", () =>
    runReplayFixture({
      fixtureName: scenario,
      harness: PiOrchestratorReplayHarness,
      transformTranscript: withNativeQuestion(scenario, [
        {
          type: "expect_outbound",
          label: "extension_ui_response",
          frame: { type: "extension_ui_response", id: question.id, answers: answered },
        },
        questionResolved("answered", answered),
      ]),
      buildInput: () => ({
        steps: [
          piCompactionInput().steps[0]!,
          { type: "await_run_status", targetRunIndex: 1, status: "completed" },
          {
            type: "answer_next_user_input_request",
            answers: { q1: "Red", q2: ["Cheese", "Ham"] },
          },
        ],
      }),
      driver: {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./fixtures/pi_compaction/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: (result) => {
          const projection = projectionFor(result, scenario);
          const [run] = projection.runs;
          assert.equal(run?.status, "completed");
          const request = projection.runtimeRequests.find(
            (candidate) => candidate.nativeRequestRef?.nativeId === question.id,
          );
          assert.equal(request?.status, "resolved");
          assert.isTrue(
            DateTime.toEpochMillis(request!.resolvedAt!) >=
              DateTime.toEpochMillis(run!.completedAt!),
            "the answer must land after the turn completed",
          );
          const card = projection.turnItems.find(
            (item) => item.type === "user_input_request" && item.requestId === request!.id,
          );
          assert.equal(card?.status, "completed");
          assert.deepEqual(
            card?.type === "user_input_request"
              ? card.questions.map((entry) => [entry.id, entry.multiSelect])
              : [],
            [
              ["q1", false],
              ["q2", true],
            ],
          );
        },
      },
    }),
  );
  it.effect("cancels a surviving non-blocking question when the idle thread is stopped", () =>
    runReplayFixture({
      fixtureName: `${scenario}_stop`,
      harness: PiOrchestratorReplayHarness,
      transformTranscript: withNativeQuestion(`${scenario}_stop`, [
        {
          type: "expect_outbound",
          label: "extension_ui_response",
          frame: { type: "extension_ui_response", id: question.id, cancelled: true },
        },
        questionResolved("cancelled", {}),
      ]),
      buildInput: () => ({
        steps: [
          piCompactionInput().steps[0]!,
          { type: "await_run_status", targetRunIndex: 1, status: "completed" },
          { type: "stop_thread" },
        ],
      }),
      driver: {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./fixtures/pi_compaction/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: (result) => {
          const projection = projectionFor(result, `${scenario}_stop`);
          assert.equal(projection.runs[0]?.status, "completed");
          const request = projection.runtimeRequests.find(
            (candidate) => candidate.nativeRequestRef?.nativeId === question.id,
          );
          assert.isDefined(request);
          assert.notEqual(request?.status, "pending");
          assert.isFalse(
            projection.runtimeRequests.some((candidate) => candidate.status === "pending"),
          );
          const card = projection.turnItems.find(
            (item) => item.type === "user_input_request" && item.requestId === request!.id,
          );
          assert.equal(card?.status, "cancelled");
        },
      },
    }),
  );
});
