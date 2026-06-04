import type {
  CaseExpectation,
  ExpectationCheck,
  JudgmentGrade,
  JudgmentVerdict,
} from "./types";

export function computeVerdict(
  grades: Record<string, JudgmentGrade>,
  thresholds: Record<string, number>
): JudgmentVerdict {
  let hasNeedsReview = false;

  for (const [dimension, threshold] of Object.entries(thresholds)) {
    const grade = grades[dimension];
    if (typeof grade !== "number") {
      return "fail";
    }
    if (grade < threshold) {
      return "fail";
    }
    if (grade < threshold + 1) {
      hasNeedsReview = true;
    }
  }

  for (const [dimension, grade] of Object.entries(grades)) {
    if (typeof grade === "number") {
      continue;
    }

    if (grade === "fail") {
      return "fail";
    }
    if (grade === "needs_review") {
      hasNeedsReview = true;
    }
  }

  return hasNeedsReview ? "needs_review" : "pass";
}

export function evaluateExpectations(
  stageType: string,
  grades: Record<string, JudgmentGrade>,
  expectations: CaseExpectation[] = [],
  checks: readonly ExpectationCheck[] = []
): { matched: boolean; detail?: string } | null {
  const relevant = expectations.filter((expectation) => expectation.stageType === stageType);
  if (relevant.length === 0) {
    return null;
  }

  const misses: string[] = [];

  for (const expectation of relevant) {
    if (expectation.goldenArtifactId) {
      const goldenCheck = checks.find(
        (check) =>
          check.kind === "golden_artifact" &&
          check.goldenArtifactId === expectation.goldenArtifactId
      );
      if (!goldenCheck) {
        misses.push(`missing goldenArtifactId check ${expectation.goldenArtifactId}`);
      } else if (!goldenCheck.matched) {
        misses.push(goldenCheck.detail ?? `${expectation.goldenArtifactId} did not match`);
      }
    }

    for (const assertion of expectation.assertions ?? []) {
      const assertionCheck = checks.find(
        (check) => check.kind === "assertion" && check.assertion === assertion
      );
      if (!assertionCheck) {
        misses.push(`missing assertion check "${assertion}"`);
      } else if (!assertionCheck.matched) {
        misses.push(assertionCheck.detail ?? `assertion failed "${assertion}"`);
      }
    }

    for (const [dimension, floor] of Object.entries(expectation.gradeFloors ?? {})) {
      const grade = grades[dimension];
      if (typeof grade !== "number") {
        misses.push(`${dimension} was not numeric`);
        continue;
      }
      if (grade < floor) {
        misses.push(`${dimension} ${grade} < ${floor}`);
      }
    }
  }

  return {
    matched: misses.length === 0,
    ...(misses.length > 0 ? { detail: misses.join("; ") } : {}),
  };
}
