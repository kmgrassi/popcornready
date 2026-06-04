import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { canAccessAdminSurface } from "../components/auth/AdminRoute";
import { useAuth } from "../components/auth/AuthProvider";
import { JudgmentBadge, verdictLabel, VerdictDot } from "../components/evals/JudgmentBadge";
import { ApiClientError } from "../lib/api-client";
import {
  evalApi,
  stageLabel,
  toRunDetail,
  toSuiteSummary,
  type EvalRunDetailView,
  type EvalSuiteSummaryView,
  type VerdictFlip,
} from "../lib/evals/api";
import {
  fallbackEvalSuites,
  fallbackRunDetails,
  fallbackVerdictFlips,
} from "../lib/evals/fallback";

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong loading the eval data.";
}

function isEvalApiUnavailable(err: unknown): boolean {
  return (
    err instanceof ApiClientError &&
    err.status === 404 &&
    (err.message.includes("/api/v1/eval") || err.code === "internal_error")
  );
}

export function EvalsPage() {
  const auth = useAuth();
  const showWorkbenchLink = canAccessAdminSurface(auth);

  const [suites, setSuites] = useState<EvalSuiteSummaryView[]>([]);
  const [suitesLoading, setSuitesLoading] = useState(true);
  const [suitesError, setSuitesError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<EvalRunDetailView | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [flips, setFlips] = useState<VerdictFlip[] | null>(null);
  const [flipsError, setFlipsError] = useState<string | null>(null);

  const loadSuites = useCallback((signal?: AbortSignal) => {
    setSuitesLoading(true);
    setSuitesError(null);
    return evalApi
      .listSuites(signal)
      .then((res) => {
        if (signal?.aborted) return;
        const views = res.suites.map(toSuiteSummary);
        setUsingFallback(false);
        setSuites(views);
        setActiveRunId((current) =>
          current && views.some((suite) => suite.latestRunId === current)
            ? current
            : views.find((suite) => suite.latestRunId)?.latestRunId ?? null,
        );
      })
      .catch((err) => {
        if (signal?.aborted) return;
        if (isEvalApiUnavailable(err)) {
          setUsingFallback(true);
          setSuites(fallbackEvalSuites);
          setActiveRunId((current) =>
            current && fallbackEvalSuites.some((suite) => suite.latestRunId === current)
              ? current
              : fallbackEvalSuites.find((suite) => suite.latestRunId)?.latestRunId ?? null,
          );
          return;
        }
        setUsingFallback(false);
        setSuitesError(errorMessage(err));
      })
      .finally(() => {
        if (signal?.aborted) return;
        setSuitesLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSuites(controller.signal);
    return () => controller.abort();
  }, [loadSuites]);

  useEffect(() => {
    if (!activeRunId) {
      setRunDetail(null);
      return;
    }
    if (usingFallback) {
      setRunLoading(false);
      setRunError(null);
      setRunDetail(fallbackRunDetails[activeRunId] ?? null);
      return;
    }
    const controller = new AbortController();
    setRunLoading(true);
    setRunError(null);
    evalApi
      .getRun(activeRunId, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setRunDetail(toRunDetail(payload));
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setRunError(errorMessage(err));
        setRunDetail(null);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setRunLoading(false);
      });
    return () => controller.abort();
  }, [activeRunId, usingFallback]);

  // Diff the active run against the prior run of the same suite — that is the
  // "money view" (did my change regress?). The server carries the lineage on the
  // run payload, so a missing prior simply yields no flips.
  useEffect(() => {
    if (!runDetail || !runDetail.previousRunId) {
      setFlips(null);
      setFlipsError(null);
      return;
    }
    if (usingFallback) {
      setFlips(fallbackVerdictFlips[runDetail.runId] ?? []);
      setFlipsError(null);
      return;
    }
    const controller = new AbortController();
    evalApi
      .diffRun(runDetail.runId, runDetail.previousRunId, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setFlips(res.flips);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setFlipsError(errorMessage(err));
        setFlips(null);
      });
    return () => controller.abort();
  }, [runDetail, usingFallback]);

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
            <button type="button" onClick={() => loadSuites()}>
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
