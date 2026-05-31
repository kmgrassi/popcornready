import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSemanticAnalysis,
  textEditToEditDecision,
  transcriptFromText,
} from "../semantic-analysis";

test("buildSemanticAnalysis creates transcript spans and moment segments", () => {
  const analysis = buildSemanticAnalysis(
    {
      id: "asset_1",
      kind: "video",
      durationSec: 10,
      source: { type: "local_path" },
      context: {
        transcriptText: "Open with the customer pain then show the product payoff.",
        recommendedRoles: ["hook", "demo"],
        moments: [
          { startSec: 0, endSec: 4, label: "customer pain" },
          { startSec: 4, endSec: 10, label: "product payoff" },
        ],
      },
    },
    { now: "2026-05-31T00:00:00.000Z" }
  );

  assert.equal(analysis.schemaVersion, "semanticAnalysis.v1");
  assert.equal(analysis.assetId, "asset_1");
  assert.equal(analysis.transcript.length, 2);
  assert.equal(
    analysis.transcript.reduce((count, span) => count + span.words.length, 0),
    10
  );
  assert.deepEqual(
    analysis.segments.map((segment) => segment.transcriptSpanIds),
    [["asset_1_span_1"], ["asset_1_span_2"]]
  );
  assert.deepEqual(
    analysis.segments.map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      tags: segment.semanticTags,
    })),
    [
      {
        startMs: 0,
        endMs: 4000,
        tags: ["video", "local_path", "hook", "demo", "customer pain"],
      },
      {
        startMs: 4000,
        endMs: 10000,
        tags: ["video", "local_path", "hook", "demo", "product payoff"],
      },
    ]
  );
});

test("buildSemanticAnalysis keeps summaries out of transcript", () => {
  const analysis = buildSemanticAnalysis({
    id: "asset_summary",
    kind: "image",
    context: {
      summary: "A product screenshot with the dashboard open.",
      recommendedRoles: ["demo"],
    },
  });

  assert.deepEqual(analysis.transcript, []);
  assert.equal(analysis.segments[0].visualDescription, "A product screenshot with the dashboard open.");
});

test("textEditToEditDecision maps word edits back to source segments", () => {
  const transcript = transcriptFromText({
    assetId: "asset_2",
    text: "Keep this sentence but remove this filler",
    durationMs: 7000,
  });
  const analysis = {
    transcript,
    segments: [
      {
        id: "seg_1",
        assetId: "asset_2",
        startMs: 0,
        endMs: 7000,
        transcriptSpanIds: [transcript[0].id],
        semanticTags: ["video"],
      },
    ],
  };
  const removeWord = transcript[0].words.find((word) => word.word === "filler");
  assert.ok(removeWord);

  const decision = textEditToEditDecision(
    analysis,
    { type: "remove_words", wordIds: [removeWord.id], reason: "Remove filler word." },
    { id: "decision_1", beatId: "hook", confidence: 0.9 }
  );

  assert.equal(decision.schemaVersion, "editDecision.v1");
  assert.equal(decision.operation, "cut");
  assert.deepEqual(decision.sourceSegmentIds, ["seg_1"]);
  assert.deepEqual(decision.constraints?.mustIncludeWords, ["filler"]);
  assert.equal(decision.rationale, "Remove filler word.");
  assert.equal(decision.confidence, 0.9);
});

test("textEditToEditDecision targets only the matching moment segment", () => {
  const analysis = buildSemanticAnalysis({
    id: "asset_3",
    kind: "video",
    durationSec: 8,
    context: {
      transcriptText: "First hook words second payoff words",
      moments: [
        { startSec: 0, endSec: 4, label: "hook" },
        { startSec: 4, endSec: 8, label: "payoff" },
      ],
    },
  });
  const payoffWord = analysis.transcript
    .flatMap((span) => span.words)
    .find((word) => word.word === "payoff");
  assert.ok(payoffWord);

  const decision = textEditToEditDecision(
    analysis,
    { type: "caption_emphasis", wordIds: [payoffWord.id] },
    { id: "decision_2" }
  );

  assert.deepEqual(decision.sourceSegmentIds, ["asset_3_segment_2"]);
});
