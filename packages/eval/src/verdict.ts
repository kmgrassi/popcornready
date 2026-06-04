import type {
  CaseExpectation,
  JudgmentGrade,
  JudgmentVerdict,
} from "./types";

export function computeVerdict(
  grades: Record<string, JudgmentGrade>,
  thresholds: Record<string, number>
): JudgmentVerdict {
  let hasNeedsReview = false;

  for (const [dimension, grade] of Object.entries(grades)) {
    if (typeof grade === "number") {
      const threshold = thresholds[dimension];
      if (threshold == null) {
        continue;
      }
      if (grade < threshold) {
        return "fail";
      }
      if (grade < threshold + 1) {
        hasNeedsReview = true;
      }
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
  expectations: CaseExpectation[] = []
): { matched: boolean; detail?: string } | null {
  const relevant = expectations.filter((expectation) => expectation.stageType === stageType);
  if (relevant.length === 0) {
    return null;
  }

  const misses: string[] = [];

  for (const expectation of relevant) {
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
