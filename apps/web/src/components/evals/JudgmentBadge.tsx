import type { GenerationJudgmentSummary, GenerationJudgmentVerdict } from "@popcorn/shared/v1/types";

const VERDICT_LABEL: Record<GenerationJudgmentVerdict, string> = {
  pass: "Pass",
  needs_review: "Needs review",
  fail: "Fail",
};

interface JudgmentBadgeProps {
  judgment?: GenerationJudgmentSummary | null;
  compact?: boolean;
}

export function JudgmentBadge({ judgment, compact = false }: JudgmentBadgeProps) {
  if (!judgment) {
    return compact ? null : <span className="judgment-badge pending">Not judged</span>;
  }

  return (
    <span className={`judgment-badge ${judgment.verdict}`}>
      {VERDICT_LABEL[judgment.verdict]}
    </span>
  );
}

export function VerdictDot({ verdict }: { verdict: GenerationJudgmentVerdict }) {
  return <span className={`verdict-dot ${verdict}`} aria-hidden />;
}

export function verdictLabel(verdict: GenerationJudgmentVerdict): string {
  return VERDICT_LABEL[verdict];
}
