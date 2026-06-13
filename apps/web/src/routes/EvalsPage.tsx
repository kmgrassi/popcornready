import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { canAccessAdminSurface } from "../components/auth/AdminRoute";
import { useAuth } from "../components/auth/AuthProvider";
import { JudgmentBadge, verdictLabel, VerdictDot } from "../components/evals/JudgmentBadge";
import { ApiClientError } from "../lib/api-client";
import {
  stageLabel,
} from "../lib/evals/api";
import {
  useEvalRunDetailQuery,
  useEvalRunDiffQuery,
  useEvalSuitesQuery,
} from "../lib/evals/queries";

const DEV_AUTOPILOT = import.meta.env.DEV;

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong loading the eval data.";
}

export function EvalsPage() {
  const auth = useAuth();
  const showWorkbenchLink = canAccessAdminSurface(auth);
  const authScope = auth.user?.id ?? (DEV_AUTOPILOT ? "dev-autopilot" : auth.status);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const suitesQuery = useEvalSuitesQuery(authScope);
  const suites = suitesQuery.data?.suites ?? [];
  const usingFallback = suitesQuery.data?.usingFallback ?? false;
  const suitesLoading = suitesQuery.isLoading || (suitesQuery.isFetching && !suitesQuery.data);
  const suitesError = suitesQuery.error ? errorMessage(suitesQuery.error) : null;

  const runQuery = useEvalRunDetailQuery(authScope, activeRunId, usingFallback);
  const runDetail = runQuery.data ?? null;
  const runLoading = runQuery.isLoading || (runQuery.isFetching && !runQuery.data);
  const runError = runQuery.error ? errorMessage(runQuery.error) : null;

  const flipsQuery = useEvalRunDiffQuery(authScope, runDetail, usingFallback);
  const flips = runDetail?.previousRunId ? flipsQuery.data ?? null : null;
  const flipsError = flipsQuery.error ? errorMessage(flipsQuery.error) : null;

  useEffect(() => {
    if (!suitesQuery.data) return;
    setActiveRunId((current) =>
      current && suites.some((suite) => suite.latestRunId === current)
        ? current
        : suites.find((suite) => suite.latestRunId)?.latestRunId ?? null,
    );
  }, [suites, suitesQuery.data]);

  return (
    <main className="eval-page">
      <header className="eval-header">
        <div>
          <p className="eval-eyebrow">AI-as-judge test framework</p>
          <h1>Eval suites</h1>
          <p className="eval-subtitle">
            Batch regression view for stage judgments, verdict flips, and judge calibration.
          </p>
        </div>
        {showWorkbenchLink ? (
          <Link className="eval-header-action" to="/admin/evals">
            Open workbench
          </Link>
        ) : null}
      </header>

      <section className="eval-suite-grid" aria-label="Eval suites">
        {suitesLoading ? (
          <p className="eval-state muted">Loading suites…</p>
        ) : suitesError ? (
          <div className="eval-state error" role="alert">
            <p>{suitesError}</p>
            <button type="button" onClick={() => void suitesQuery.refetch()}>
              Retry
            </button>
          </div>
        ) : suites.length === 0 ? (
          <p className="eval-state muted">No eval suites yet.</p>
        ) : (
          suites.map((suite) => (
            <article className="eval-suite-card" key={suite.suiteId}>
              <div className="eval-card-head">
                <div>
                  <h2>{suite.name}</h2>
                  <p>{suite.description}</p>
                </div>
                <strong>{formatPercent(suite.latestPassRate)}</strong>
              </div>
              <div className="eval-sparkline" aria-label="Recent pass-rate trend">
                {suite.trend.map((point, index) => (
                  <span key={`${suite.suiteId}-${index}`} style={{ height: `${point * 100}%` }} />
                ))}
              </div>
              <div className="eval-stage-list">
                {suite.stageRates.map((stage) => (
                  <div className="eval-stage-row" key={stage.stage}>
                    <span>
                      <VerdictDot verdict={stage.verdict} />
                      {stage.stage}
                    </span>
                    <strong>{formatPercent(stage.passRate)}</strong>
                  </div>
                ))}
              </div>
              {suite.latestRunId ? (
                <button
                  type="button"
                  className="eval-card-link"
                  aria-pressed={activeRunId === suite.latestRunId}
                  onClick={() => setActiveRunId(suite.latestRunId)}
                >
                  Latest run {suite.latestRunId}
                </button>
              ) : (
                <span className="eval-card-link muted">No runs yet</span>
              )}
            </article>
          ))
        )}
      </section>

      <section className="eval-section">
        <div className="eval-section-head">
          <div>
            <p className="eval-eyebrow">Run detail</p>
            <h2>{runDetail ? runDetail.suiteName : "Select a run"}</h2>
          </div>
          {runDetail ? (
            <div className="eval-meta-row">
              <span>{runDetail.runId}</span>
              <span>{runDetail.generationMode}</span>
              <span>{formatPercent(runDetail.passRate)} pass</span>
            </div>
          ) : null}
        </div>

        {runLoading ? (
          <p className="eval-state muted">Loading run…</p>
        ) : runError ? (
          <p className="eval-state error" role="alert">
            {runError}
          </p>
        ) : !runDetail ? (
          <p className="eval-state muted">Pick a suite&apos;s latest run to inspect its grid.</p>
        ) : (
          <div className="eval-grid" role="table" aria-label="Cases by stages">
            <div className="eval-grid-header" role="row">
              <span role="columnheader">Case</span>
              {runDetail.stages.map((stage) => (
                <span role="columnheader" key={stage.stageType}>
                  {stage.label}
                </span>
              ))}
            </div>
            {runDetail.cases.map((testCase) => (
              <div className="eval-grid-row" role="row" key={testCase.caseId}>
                <strong role="rowheader">{testCase.label}</strong>
                {runDetail.stages.map((stage) => {
                  const cell = runDetail.cells.find(
                    (candidate) =>
                      candidate.caseId === testCase.caseId &&
                      candidate.stageType === stage.stageType,
                  );

                  return (
                    <button className="eval-grid-cell" type="button" key={stage.stageType}>
                      {cell ? (
                        <>
                          <JudgmentBadge
                            judgment={{
                              judgmentId: cell.judgmentId,
                              evaluatorId: cell.evaluatorId,
                              verdict: cell.verdict,
                              rationale: cell.rationale,
                              evidenceRef: cell.evidenceLabel,
                              createdAt: cell.createdAt,
                            }}
                          />
                          <span>{cell.evaluatorId}</span>
                          <small>{cell.evidenceLabel}</small>
                        </>
                      ) : (
                        <span className="muted">No judgment</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="eval-bottom-grid">
        <article className="eval-panel">
          <div className="eval-section-head compact">
            <h2>Verdict flips</h2>
            <span>Diff vs previous run</span>
          </div>
          {flipsError ? (
            <p className="eval-state error" role="alert">
              {flipsError}
            </p>
          ) : !runDetail ? (
            <p className="muted">Select a run to compare.</p>
          ) : !flips ? (
            <p className="muted">No prior run to diff against.</p>
          ) : flips.length === 0 ? (
            <p className="muted">No verdicts flipped.</p>
          ) : (
            flips.map((flip) => (
              <div className="eval-flip-row" key={`${flip.caseId}-${flip.stageType}`}>
                <div>
                  <strong>{flip.caseLabel}</strong>
                  <span>{stageLabel(flip.stageType)}</span>
                </div>
                <span>
                  {verdictLabel(flip.before)} {"->"} {verdictLabel(flip.after)}
                </span>
              </div>
            ))
          )}
        </article>

        <article className="eval-panel">
          <div className="eval-section-head compact">
            <h2>Judge calibration</h2>
            <span>{runDetail ? `${runDetail.calibration.labeledCases} labeled fixtures` : ""}</span>
          </div>
          {runDetail ? (
            <div className="eval-calibration">
              <strong>{formatPercent(runDetail.calibration.matchRate)}</strong>
              <p>
                Match rate across known-good and deliberately broken fixtures for the active judge
                versions.
              </p>
            </div>
          ) : (
            <p className="muted">Select a run to see calibration.</p>
          )}
        </article>
      </section>
    </main>
  );
}
