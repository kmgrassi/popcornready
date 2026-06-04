import { Link } from "react-router-dom";
import { JudgmentBadge, VerdictDot } from "../components/evals/JudgmentBadge";
import { workbenchStory } from "../lib/evals/fixtures";

export function AdminEvalsPage() {
  return (
    <main className="eval-page admin-eval-page">
      <header className="eval-header">
        <div>
          <p className="eval-eyebrow">Admin eval workbench</p>
          <h1>Manual story judgment</h1>
          <p className="eval-subtitle">
            Drive one story through bounded execution, judge each artifact, and promote useful
            runs into regression cases.
          </p>
        </div>
        <Link className="eval-header-action" to="/evals">
          Suite dashboard
        </Link>
      </header>

      <section className="workbench-topology">
        <article className="eval-panel workbench-story">
          <p className="eval-eyebrow">Active story</p>
          <h2>{workbenchStory.title}</h2>
          <div className="workbench-controls" aria-label="Workbench controls">
            <label>
              Mode
              <select defaultValue={workbenchStory.mode}>
                <option value="prompts_only">Prompts only</option>
                <option value="full">Generate for real</option>
              </select>
            </label>
            <label>
              Stop after
              <select defaultValue={workbenchStory.stopAfter}>
                <option value="creative_plan">Creative plan</option>
                <option value="asset_generation">Asset prompts</option>
                <option value="timeline_assembly">Timeline</option>
              </select>
            </label>
            <button type="button">Continue</button>
          </div>
        </article>

        <article className="eval-panel">
          <p className="eval-eyebrow">Per-story scorecard</p>
          <div className="workbench-scorecard">
            {workbenchStory.scorecard.map((score) => (
              <div className="workbench-score-row" key={score.stage}>
                <span>
                  <VerdictDot verdict={score.verdict} />
                  {score.stage}
                </span>
                <p>{score.summary}</p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="eval-section">
        <div className="eval-section-head">
          <div>
            <p className="eval-eyebrow">Artifacts</p>
            <h2>Judge one output at a time</h2>
          </div>
          <button type="button" className="secondary">
            Promote to regression case
          </button>
        </div>

        <div className="workbench-artifact-grid">
          {workbenchStory.artifacts.map((artifact) => (
            <article className="workbench-artifact-card" key={artifact.artifactId}>
              <div className="eval-card-head">
                <div>
                  <span>{artifact.stage}</span>
                  <h3>{artifact.title}</h3>
                </div>
                <JudgmentBadge
                  judgment={
                    artifact.verdict
                      ? {
                          judgmentId: `${artifact.artifactId}-judgment`,
                          evaluatorId: `${artifact.kind}.v1`,
                          verdict: artifact.verdict,
                          rationale: artifact.rationale ?? "",
                          createdAt: "2026-06-04T11:20:00.000Z",
                        }
                      : null
                  }
                />
              </div>
              <div className="workbench-artifact-preview">
                <span>{artifact.kind.replace("_", " ")}</span>
                <code>{artifact.artifactId}</code>
              </div>
              {artifact.rationale ? <p>{artifact.rationale}</p> : <p>No judgment yet.</p>}
              <div className="workbench-card-actions">
                <button type="button">Run judge</button>
                <button type="button" className="secondary">
                  Re-run artifact
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
