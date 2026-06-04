import assert from "node:assert/strict";
import test from "node:test";

import { computeVerdict, evaluateExpectations } from "./verdict";

test("computeVerdict fails when any numeric grade is below its threshold", () => {
  assert.equal(computeVerdict({ storyArc: 6.9, clarity: 10 }, { storyArc: 7 }), "fail");
});

test("computeVerdict fails when a thresholded grade is missing", () => {
  assert.equal(
    computeVerdict({ storyArc: 9 }, { storyArc: 7, visualFeasibility: 7 }),
    "fail"
  );
});

test("computeVerdict fails when a thresholded grade is not numeric", () => {
  assert.equal(computeVerdict({ storyArc: "pass" }, { storyArc: 7 }), "fail");
});

test("computeVerdict returns needs_review for threshold-adjacent numeric grades", () => {
  assert.equal(computeVerdict({ storyArc: 7.5 }, { storyArc: 7 }), "needs_review");
});

test("computeVerdict treats explicit fail and needs_review grades as authoritative", () => {
  assert.equal(computeVerdict({ continuity: "fail", pacing: 10 }, { pacing: 7 }), "fail");
  assert.equal(
    computeVerdict({ continuity: "needs_review", pacing: 10 }, { pacing: 7 }),
    "needs_review"
  );
});

test("evaluateExpectations reports grade floor misses for matching stages", () => {
  assert.deepEqual(
    evaluateExpectations(
      "creative_plan",
      { storyArc: 6 },
      [{ stageType: "creative_plan", gradeFloors: { storyArc: 7 } }]
    ),
    { matched: false, detail: "storyArc 6 < 7" }
  );
});

test("evaluateExpectations does not count needs_review as a floor match", () => {
  assert.deepEqual(
    evaluateExpectations(
      "creative_plan",
      { storyArc: "needs_review" },
      [{ stageType: "creative_plan", gradeFloors: { storyArc: 7 } }]
    ),
    { matched: false, detail: "storyArc was not numeric" }
  );
});

test("evaluateExpectations fails closed for unsupported golden and assertion expectations", () => {
  assert.deepEqual(
    evaluateExpectations(
      "creative_plan",
      { storyArc: 9 },
      [
        {
          stageType: "creative_plan",
          goldenArtifactId: "golden-plan",
          assertions: ["The plan resolves the conflict."],
        },
      ]
    ),
    {
      matched: false,
      detail:
        "goldenArtifactId expectations are not supported yet; assertion expectations are not supported yet",
    }
  );
});
