import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_OBSERVATIONAL_SAMPLING, shouldRunEvaluator } from "./sampling";

test("sampling always runs blocking gates and text outputs", () => {
  assert.equal(
    shouldRunEvaluator({
      evaluator: { mode: "blocking_gate", modality: "video" },
      target: {},
      policy: { textStructuredRate: 1, mediaClipRate: 0 },
    }),
    true
  );

  assert.equal(
    shouldRunEvaluator({
      evaluator: { mode: "observational", modality: "plan" },
      target: {},
      policy: { textStructuredRate: 1, mediaClipRate: 0 },
    }),
    true
  );
});

test("media observational sampling is per clip and starts at 100 percent", () => {
  assert.equal(DEFAULT_OBSERVATIONAL_SAMPLING.mediaClipRate, 1);

  assert.equal(
    shouldRunEvaluator({
      evaluator: { mode: "observational", modality: "video" },
      target: { itemId: "clip-1" },
    }),
    true
  );

  assert.equal(
    shouldRunEvaluator({
      evaluator: { mode: "observational", modality: "video" },
      target: {},
    }),
    false
  );
});
