import { useState } from "react";
import { Link } from "react-router-dom";
import { JudgmentBadge, VerdictDot } from "../components/evals/JudgmentBadge";
import { ApiClientError } from "../lib/api-client";
import { evalApi } from "../lib/evals/api";
import { workbenchStory, type WorkbenchArtifact } from "../lib/evals/fixtures";

function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Failed to run the judge.";
}

// The artifact-board content (the story's prompts/specs as cards) is produced by
// a `manual_workbench` generation run in `prompts_only` mode. The generation-runs
// API needs the new `prompts_only` + `stopAfter` run params (a parallel agent is
// adding them to the run input/engine) before we can drive a real run and stream
// its artifacts here, so the board is seeded from the workbench fixture for now.
// The per-card "Run judge" action below is wired to the real `POST /judgments`
// endpoint, which is fully contracted.
// TODO(eval-workbench): replace the fixture seed with a real workbench run once
// generation-runs accepts `prompts_only` + `stopAfter`; then `mode`/`stopAfter`
// controls and "Promote to regression case" drive the live engine.

interface CardState {
  artifact: WorkbenchArtifact;
  judging: boolean;
  error: string | null;
}

export function AdminEvalsPage() {
  const [cards, setCards] = useState<CardState[]>(() =>
    workbenchStory.artifacts.map((artifact) => ({ artifact, judging: false, error: null })),
  );

  async function runJudge(artifactId: string, evaluatorId: string) {
    setCards((prev) =>
      prev.map((card) =>
        card.artifact.artifactId === artifactId
          ? { ...card, judging: true, error: null }
          : card,
      ),
    );

    try {
      const { judgment } = await evalApi.runJudgment({ evaluatorId, artifactId });
      setCards((prev) =>
        prev.map((card) =>
          card.artifact.artifactId === artifactId
            ? {
                artifact: {
                  ...card.artifact,
                  status: "judged",
                  verdict: judgment.verdict,
                  rationale: judgment.rationale,
                },
                judging: false,
                error: null,
              }
            : card,
        ),
      );
    } catch (err) {
      setCards((prev) =>
        prev.map((card) =>
          card.artifact.artifactId === artifactId
            ? { ...card, judging: false, error: errorMessage(err) }
            : card,
        ),
      );
    }
  }

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
              <select defaultValue={workbenchStory.mode} disabled>
                <option value="prompts_only">Prompts only</option>
                <option value="full">Generate for real</option>
              </select>
            </label>
            <label>
              Stop after
              <select defaultValue={workbenchStory.stopAfter} disabled>
                <option value="creative_plan">Creative plan</option>
                <option value="asset_generation">Asset prompts</option>
                <option value="timeline_assembly">Timeline</option>
              </select>
            </label>
            <button type="button" disabled>
              Continue
            </button>
          </div>
          <p className="muted workbench-note">
            Bounded-execution controls light up once generation-runs accepts
            <code> prompts_only</code> + <code>stopAfter</code>.
          </p>
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
          <button type="button" className="secondary" disabled>
            Promote to regression case
          </button>
        </div>

        <div className="workbench-artifact-grid">
          {cards.map(({ artifact, judging, error }) => {
            const evaluatorId = `${artifact.kind}.v1`;
            return (
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
                            evaluatorId,
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
                {error ? (
                  <p className="eval-state error" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="workbench-card-actions">
                  <button
                    type="button"
                    disabled={judging}
                    onClick={() => runJudge(artifact.artifactId, evaluatorId)}
                  >
                    {judging ? "Judging…" : "Run judge"}
                  </button>
                  <button type="button" className="secondary" disabled>
                    Re-run artifact
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
