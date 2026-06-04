import { Link } from "react-router-dom";
import { canAccessAdminSurface } from "../components/auth/AdminRoute";
import { useAuth } from "../components/auth/AuthProvider";
import { JudgmentBadge, verdictLabel, VerdictDot } from "../components/evals/JudgmentBadge";
import { evalRunDetail, evalSuites } from "../lib/evals/fixtures";

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function EvalsPage() {
  const auth = useAuth();
  const showWorkbenchLink = canAccessAdminSurface(auth);

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
        {evalSuites.map((suite) => (
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
            <Link className="eval-card-link" to="/evals">
              Latest run {suite.latestRunId}
            </Link>
          </article>
        ))}
      </section>

      <section className="eval-section">
        <div className="eval-section-head">
          <div>
            <p className="eval-eyebrow">Run detail</p>
            <h2>{evalRunDetail.suiteName}</h2>
          </div>
          <div className="eval-meta-row">
            <span>{evalRunDetail.runId}</span>
            <span>{evalRunDetail.generationMode}</span>
            <span>{formatPercent(evalRunDetail.passRate)} pass</span>
          </div>
        </div>

        <div className="eval-grid" role="table" aria-label="Cases by stages">
          <div className="eval-grid-header" role="row">
            <span role="columnheader">Case</span>
            {evalRunDetail.stages.map((stage) => (
              <span role="columnheader" key={stage}>
                {stage}
              </span>
            ))}
          </div>
          {evalRunDetail.cases.map((testCase) => (
            <div className="eval-grid-row" role="row" key={testCase.caseId}>
              <strong role="rowheader">{testCase.label}</strong>
              {evalRunDetail.stages.map((stage) => {
                const cell = evalRunDetail.cells.find(
                  (candidate) => candidate.caseId === testCase.caseId && candidate.stage === stage,
                );

                return (
                  <button className="eval-grid-cell" type="button" key={stage}>
                    {cell ? (
                      <>
                        <JudgmentBadge
                          judgment={{
                            judgmentId: `${cell.caseId}-${cell.stage}`,
                            evaluatorId: cell.evaluatorId,
                            verdict: cell.verdict,
                            rationale: cell.rationale,
                            evidenceRef: cell.evidenceLabel,
                            createdAt: evalRunDetail.createdAt,
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
      </section>

      <section className="eval-bottom-grid">
        <article className="eval-panel">
          <div className="eval-section-head compact">
            <h2>Verdict flips</h2>
            <span>Diff vs previous run</span>
          </div>
          {evalRunDetail.flippedVerdicts.map((flip) => (
            <div className="eval-flip-row" key={`${flip.caseLabel}-${flip.stage}`}>
              <div>
                <strong>{flip.caseLabel}</strong>
                <span>{flip.stage}</span>
              </div>
              <span>
                {verdictLabel(flip.before)} {"->"} {verdictLabel(flip.after)}
              </span>
            </div>
          ))}
        </article>

        <article className="eval-panel">
          <div className="eval-section-head compact">
            <h2>Judge calibration</h2>
            <span>{evalRunDetail.calibration.labeledCases} labeled fixtures</span>
          </div>
          <div className="eval-calibration">
            <strong>{formatPercent(evalRunDetail.calibration.matchRate)}</strong>
            <p>
              Match rate across known-good and deliberately broken fixtures for the active judge
              versions.
            </p>
          </div>
        </article>
      </section>
    </main>
  );
}
