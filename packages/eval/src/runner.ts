import { randomUUID } from "node:crypto";

import type {
  EvalFixtureArtifact,
  EvalRun,
  EvalRunResult,
  EvalSuiteFixture,
  Evaluator,
  EvaluatorContext,
  ExpectationCheck,
  Judgment,
} from "./types";
import { EvaluatorRegistry } from "./registry";
import { computeVerdict, evaluateExpectations } from "./verdict";

export interface RunEvalSuiteOptions {
  registry: EvaluatorRegistry;
  fixture: EvalSuiteFixture;
  evalRunId?: string;
  gitSha: string;
  branch: string;
  now?: () => Date;
  id?: () => string;
}

export async function runEvalSuite(options: RunEvalSuiteOptions): Promise<EvalRunResult> {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const createdAt = now().toISOString();
  const evalRunId = options.evalRunId ?? id();
  const judgments: Judgment[] = [];
  const expectationResults: EvalRunResult["expectationResults"] = [];

  const evalRun: EvalRun = {
    id: evalRunId,
    source: "suite",
    suiteId: options.fixture.suite.id,
    generationMode: "prompts_only",
    gitSha: options.gitSha,
    branch: options.branch,
    judgeModels: {},
    status: "running",
    createdAt,
  };

  for (const fixtureCase of options.fixture.cases) {
    for (const artifact of artifactsForCase(fixtureCase.artifacts, fixtureCase.stagesToRun)) {
      const evaluators = options.registry.forStage(artifact.stageType, artifact.tool);
      for (const evaluator of evaluators) {
        evalRun.judgeModels[evaluator.id] = evaluator.judgeModel;
        const { judgment, expectationChecks } = await runEvaluator({
          evaluator,
          artifact,
          caseId: fixtureCase.id,
          evalRunId,
          expectations: fixtureCase.expectations,
          now,
          id,
        });
        judgments.push(judgment);

        const expectation = evaluateExpectations(
          artifact.stageType,
          judgment.grades,
          fixtureCase.expectations,
          expectationChecks
        );
        if (expectation) {
          expectationResults.push({
            evalRunId,
            caseId: fixtureCase.id,
            judgmentId: judgment.id,
            matched: expectation.matched,
            ...(expectation.detail ? { detail: expectation.detail } : {}),
          });
        }
      }
    }
  }

  evalRun.status = "succeeded";
  evalRun.completedAt = now().toISOString();
  evalRun.aggregate = aggregateJudgments(judgments);

  return { evalRun, judgments, expectationResults };
}

async function runEvaluator(args: {
  evaluator: Evaluator;
  artifact: EvalFixtureArtifact;
  caseId: string;
  evalRunId: string;
  expectations: EvaluatorContext["expectations"];
  now: () => Date;
  id: () => string;
}): Promise<{ judgment: Judgment; expectationChecks: ExpectationCheck[] }> {
  const stageId = `${args.caseId}:${args.artifact.stageType}`;
  const context: EvaluatorContext = {
    stageType: args.artifact.stageType,
    tool: args.artifact.tool,
    modality: args.evaluator.modality,
    artifact: args.artifact.artifact,
    intent: args.artifact.intent,
    expectations: args.expectations,
    evidenceRef: args.artifact.evidenceRef,
    caseId: args.caseId,
    stageId,
    itemId: args.artifact.itemId,
    artifactId: args.artifact.artifactId,
    assetId: args.artifact.assetId,
    trigger: "auto",
  };

  const startedAt = Date.now();
  const draft = await args.evaluator.run(context);
  const latencyMs = draft.latencyMs ?? Date.now() - startedAt;

  return {
    judgment: {
      id: args.id(),
      evaluatorId: args.evaluator.id,
      rubricVersion: args.evaluator.rubricVersion,
      judgeModel: args.evaluator.judgeModel,
      evalRunId: args.evalRunId,
      caseId: args.caseId,
      stageId,
      itemId: args.artifact.itemId,
      artifactId: args.artifact.artifactId,
      assetId: args.artifact.assetId,
      grades: draft.grades,
      verdict: computeVerdict(draft.grades, args.evaluator.thresholds),
      rationale: draft.rationale,
      recommendedAction: draft.recommendedAction,
      evidenceRef: draft.evidenceRef ?? args.artifact.evidenceRef,
      trigger: "auto",
      costUsd: draft.costUsd ?? 0,
      latencyMs,
      createdAt: args.now().toISOString(),
    },
    expectationChecks: draft.expectationChecks ?? [],
  };
}

function artifactsForCase(
  artifacts: EvalFixtureArtifact[],
  stagesToRun: EvalSuiteFixture["cases"][number]["stagesToRun"]
): EvalFixtureArtifact[] {
  const stages = new Set(stagesToRun);
  return artifacts.filter((artifact) => stages.has(artifact.stageType));
}

function aggregateJudgments(judgments: Judgment[]): Record<string, number> {
  const aggregate: Record<string, number> = {
    total: judgments.length,
    passRate: 0,
    needsReviewRate: 0,
    failRate: 0,
  };
  if (judgments.length === 0) {
    return aggregate;
  }

  const passes = judgments.filter((judgment) => judgment.verdict === "pass").length;
  const needsReview = judgments.filter(
    (judgment) => judgment.verdict === "needs_review"
  ).length;
  const failures = judgments.filter((judgment) => judgment.verdict === "fail").length;

  aggregate.passRate = passes / judgments.length;
  aggregate.needsReviewRate = needsReview / judgments.length;
  aggregate.failRate = failures / judgments.length;
  return aggregate;
}
