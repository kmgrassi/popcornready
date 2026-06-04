// Typed client for the stage-eval HTTP API (docs/scopes/stage-eval-framework.md
// §6B/§6C). Base path `/api/v1/eval`. Wire shapes come from `@popcorn/eval`
// (EvalSuite / EvalRun / Judgment / …) — we import them rather than redeclare,
// and map them into the view shapes the dashboard/workbench components render.
//
// A parallel agent implements this surface server-side to the same contract; the
// response envelopes below are the agreed shape. See README in this PR for the
// assumptions that may drift.

import type {
  EvalRun,
  EvalSuite,
  GenerationStageType,
  Judgment,
  JudgmentVerdict,
} from "@popcorn/eval";
import { GENERATION_STAGE_LABELS } from "@popcorn/shared/v1/types";
import { apiRequest } from "../api-client";

// --- Wire contract -------------------------------------------------------

// `GET /suites` and `GET /suites/:id` enrich the bare EvalSuite with the latest
// run's roll-up so the dashboard can render the card without a second fetch.
export interface EvalSuiteWithLatest extends EvalSuite {
  latestPassRate: number;
  latestRunId: string | null;
  // Most-recent-last pass-rate trend across recent eval runs.
  trend: number[];
  stageRates: Array<{
    stageType: GenerationStageType;
    passRate: number;
    verdict: JudgmentVerdict;
  }>;
}

export interface ListSuitesResponse {
  suites: EvalSuiteWithLatest[];
}

export interface SuiteResponse {
  suite: EvalSuiteWithLatest;
}

export interface EvalRunCaseRef {
  caseId: string;
  label: string;
}

// The wire Judgment row only exposes opaque graph ids (`stageId`, `caseId`).
// For the cases × stages grid the server resolves each judgment's grid
// coordinates — the case it belongs to and the stage it judged — and echoes
// them alongside the Judgment so the client can place the cell without a
// second lookup.
export interface EvalRunJudgment extends Judgment {
  stageType: GenerationStageType;
}

// `GET /runs/:id` — the run plus the cases it exercised and every Judgment it
// produced, enough to build the cases × stages grid and the calibration panel.
export interface EvalRunResponse {
  evalRun: EvalRun;
  suiteName: string | null;
  passRate: number;
  // The prior eval run of the same suite, for the default diff ("did my change
  // regress?"). Null for the suite's first run.
  previousRunId: string | null;
  cases: EvalRunCaseRef[];
  // Stages exercised, in canonical order; the grid columns.
  stages: GenerationStageType[];
  judgments: EvalRunJudgment[];
  calibration: {
    matchRate: number;
    labeledCases: number;
  };
}

export interface VerdictFlip {
  caseId: string;
  caseLabel: string;
  stageType: GenerationStageType;
  before: JudgmentVerdict;
  after: JudgmentVerdict;
}

export interface RunDiffResponse {
  runId: string;
  againstRunId: string;
  flips: VerdictFlip[];
}

export interface StartRunInput {
  suiteId: string;
  generationMode?: EvalRun["generationMode"];
  stopAfter?: GenerationStageType;
}

export interface StartRunResponse {
  evalRun: EvalRun;
}

export interface RunJudgmentInput {
  evaluatorId: string;
  artifactId: string;
}

export interface RunJudgmentResponse {
  judgment: Judgment;
}

// --- Endpoints -----------------------------------------------------------

const EVAL_BASE = "/api/v1/eval";

export const evalApi = {
  listSuites: (signal?: AbortSignal) =>
    apiRequest<ListSuitesResponse>(`${EVAL_BASE}/suites`, { signal }),

  getSuite: (suiteId: string, signal?: AbortSignal) =>
    apiRequest<SuiteResponse>(
      `${EVAL_BASE}/suites/${encodeURIComponent(suiteId)}`,
      { signal },
    ),

  getRun: (runId: string, signal?: AbortSignal) =>
    apiRequest<EvalRunResponse>(
      `${EVAL_BASE}/runs/${encodeURIComponent(runId)}`,
      { signal },
    ),

  startRun: (input: StartRunInput) =>
    apiRequest<StartRunResponse>(`${EVAL_BASE}/runs`, {
      method: "POST",
      body: input,
    }),

  diffRun: (runId: string, againstRunId: string, signal?: AbortSignal) =>
    apiRequest<RunDiffResponse>(
      `${EVAL_BASE}/runs/${encodeURIComponent(runId)}/diff`,
      { searchParams: { against: againstRunId }, signal },
    ),

  runJudgment: (input: RunJudgmentInput) =>
    apiRequest<RunJudgmentResponse>(`${EVAL_BASE}/judgments`, {
      method: "POST",
      body: input,
    }),
};

// --- View mapping --------------------------------------------------------

export function stageLabel(stageType: GenerationStageType): string {
  return GENERATION_STAGE_LABELS[stageType] ?? stageType;
}

export interface EvalSuiteSummaryView {
  suiteId: string;
  name: string;
  description: string;
  latestPassRate: number;
  latestRunId: string | null;
  trend: number[];
  stageRates: Array<{
    stage: string;
    passRate: number;
    verdict: JudgmentVerdict;
  }>;
}

export function toSuiteSummary(suite: EvalSuiteWithLatest): EvalSuiteSummaryView {
  return {
    suiteId: suite.id,
    name: suite.name,
    description: suite.description ?? "",
    latestPassRate: suite.latestPassRate,
    latestRunId: suite.latestRunId,
    trend: suite.trend,
    stageRates: suite.stageRates.map((rate) => ({
      stage: stageLabel(rate.stageType),
      passRate: rate.passRate,
      verdict: rate.verdict,
    })),
  };
}

export interface EvalRunGridCellView {
  caseId: string;
  stage: string;
  stageType: GenerationStageType;
  verdict: JudgmentVerdict;
  evaluatorId: string;
  rationale: string;
  evidenceLabel: string;
  judgmentId: string;
  createdAt: string;
}

export interface EvalRunDetailView {
  runId: string;
  source: EvalRun["source"];
  suiteName: string;
  generationMode: EvalRun["generationMode"];
  branch: string;
  gitSha: string;
  createdAt: string;
  passRate: number;
  previousRunId: string | null;
  cases: EvalRunCaseRef[];
  stages: Array<{ stageType: GenerationStageType; label: string }>;
  cells: EvalRunGridCellView[];
  calibration: { matchRate: number; labeledCases: number };
}

export function toRunDetail(payload: EvalRunResponse): EvalRunDetailView {
  // Most-recent judgment wins per (case, stage) cell — judgments are
  // append-only, so a re-judge supersedes the earlier verdict.
  const byCell = new Map<string, EvalRunJudgment>();
  for (const judgment of payload.judgments) {
    if (!judgment.caseId) continue;
    const key = `${judgment.caseId}::${judgment.stageType}`;
    const existing = byCell.get(key);
    if (!existing || judgment.createdAt > existing.createdAt) {
      byCell.set(key, judgment);
    }
  }

  const cells: EvalRunGridCellView[] = [];
  for (const judgment of byCell.values()) {
    cells.push({
      caseId: judgment.caseId!,
      stage: stageLabel(judgment.stageType),
      stageType: judgment.stageType,
      verdict: judgment.verdict,
      evaluatorId: judgment.evaluatorId,
      rationale: judgment.rationale,
      evidenceLabel: judgment.evidenceRef ?? judgment.artifactId ?? "—",
      judgmentId: judgment.id,
      createdAt: judgment.createdAt,
    });
  }

  return {
    runId: payload.evalRun.id,
    source: payload.evalRun.source,
    suiteName: payload.suiteName ?? "Eval run",
    generationMode: payload.evalRun.generationMode,
    branch: payload.evalRun.branch,
    gitSha: payload.evalRun.gitSha,
    createdAt: payload.evalRun.createdAt,
    passRate: payload.passRate,
    previousRunId: payload.previousRunId,
    cases: payload.cases,
    stages: payload.stages.map((stageType) => ({
      stageType,
      label: stageLabel(stageType),
    })),
    cells,
    calibration: payload.calibration,
  };
}
