import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/core/errors";
import {
  approvalRejectedError,
  budgetExceededError,
  buildSelfHealTurnInput,
  classifyToolFailure,
  parseToolError,
  preconditionFromApiError,
  preconditionUnmet,
  providerQuotaError,
} from "./tool-errors";

test("builds actionable precondition errors with suggested recovery tools", () => {
  const err = preconditionUnmet({
    message: "Beat beat_03 uses a character without an active anchor.",
    unmetRequirements: [
      {
        requirement: "character_anchor",
        because: "The clip prompt references a recurring main character.",
        satisfyWith: {
          tool: "generate_anchor",
          inputHint: {
            characterId: "char_captain",
            anchorRole: "character_anchor",
          },
        },
      },
    ],
  });

  assert.equal(err.kind, "precondition_unmet");
  assert.equal(err.recoverable, true);
  assert.deepEqual(err.suggestedNextTools, [
    {
      tool: "generate_anchor",
      inputHint: {
        characterId: "char_captain",
        anchorRole: "character_anchor",
      },
    },
  ]);
});

test("converts existing ApiError preconditions into model-readable tool errors", () => {
  const err = preconditionFromApiError(
    new ApiError("brief_missing", "briefVersionId is required."),
    {
      toolName: "plan_shots",
      input: { projectId: "project_123" },
    }
  );

  assert.ok(err);
  assert.equal(err.kind, "precondition_unmet");
  assert.equal(err.unmetRequirements?.[0]?.requirement, "brief_version");
  assert.deepEqual(err.suggestedNextTools?.[0], {
    tool: "create_or_load_brief",
    inputHint: { projectId: "project_123" },
  });
});

test("classifies provider quota failures as recoverable", () => {
  const err = classifyToolFailure(new Error("OpenAI request failed (429): quota"), {
    toolName: "generate_clip",
    retryAfterSec: 60,
  });

  assert.equal(err.kind, "provider_quota");
  assert.equal(err.recoverable, true);
  assert.equal(err.retryAfterSec, 60);
});

test("builds budget approval recovery errors", () => {
  const err = budgetExceededError({
    toolName: "generate_clip",
    estimatedCostUsd: 12,
    maxUsd: 10,
    spentUsd: 8,
    inputHint: { beatId: "beat_03" },
  });

  assert.equal(err.kind, "budget_exceeded");
  assert.deepEqual(err.suggestedNextTools, [
    {
      tool: "request_approval",
      inputHint: {
        reason: "budget_exceeded",
        requestedTool: "generate_clip",
        estimatedCostUsd: 12,
        maxUsd: 10,
        spentUsd: 8,
        beatId: "beat_03",
      },
    },
  ]);
});

test("maps approval rejection notes back to likely recovery tools", () => {
  const err = approvalRejectedError({
    stageType: "storyboard",
    note: "make the clone confusion clearer by scene 2",
  });

  assert.equal(err.kind, "approval_rejected");
  assert.equal(err.recoverable, true);
  assert.deepEqual(err.suggestedNextTools, [
    {
      tool: "generate_storyboard",
      inputHint: {
        revisionInstruction: "make the clone confusion clearer by scene 2",
      },
    },
  ]);
});

test("packages self-heal context for the next model turn", () => {
  const error = providerQuotaError({
    message: "Provider quota exceeded.",
    fallbackTool: {
      tool: "generate_clip",
      inputHint: { provider: "mock" },
    },
  });

  const input = buildSelfHealTurnInput({
    failedTool: "generate_clip",
    input: { provider: "openai" },
    error,
  });

  assert.deepEqual(input.recoveryOptions, [
    {
      tool: "generate_clip",
      inputHint: { provider: "mock" },
    },
  ]);
  assert.equal(parseToolError(input.toolError)?.kind, "provider_quota");
});
