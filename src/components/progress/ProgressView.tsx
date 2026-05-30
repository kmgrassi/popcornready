"use client";

import Link from "next/link";
import { GenerationRun, GenerationStage } from "@/lib/v1/types";
import { StageRail } from "./StageRail";
import { StatusBanner } from "./StatusBanner";
import { TerminalState } from "./TerminalState";

interface ProgressViewProps {
  run: GenerationRun;
  stages: GenerationStage[];
  /** Optional list of other demo runs to link to from the header. */
  alternateRuns?: { runId: string; label: string }[];
}

function isTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

export function ProgressView({ run, stages, alternateRuns }: ProgressViewProps) {
  const terminal = isTerminal(run.status);

  return (
    <div className="progress-shell">
      <header className="progress-header">
        <div>
          <p className="progress-eyebrow">Generation run</p>
          <h1 className="progress-title">
            {run.projectId === "demo-project" ? "Demo project" : run.projectId}
          </h1>
          <p className="progress-subtitle muted">
            Run <code>{run.runId}</code>
          </p>
        </div>
        {alternateRuns && alternateRuns.length > 0 ? (
          <nav className="progress-alt-runs" aria-label="Other demo states">
            <span className="progress-alt-runs-label">View other states:</span>
            <ul>
              {alternateRuns.map((alt) => (
                <li key={alt.runId}>
                  <Link
                    href={`/projects/${run.projectId}/runs/${alt.runId}`}
                    className={`progress-alt-link${
                      alt.runId === run.runId ? " active" : ""
                    }`}
                  >
                    {alt.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </header>

      <div className="progress-body">
        <section className="progress-main">
          {terminal ? <TerminalState run={run} /> : <StatusBanner run={run} />}

          <div className="progress-empty-card">
            <h2 className="progress-card-heading">Generated assets</h2>
            <p className="muted">
              Generated visuals, audio, and timeline beats will appear here as
              each stage produces them.
            </p>
          </div>
        </section>

        <aside className="progress-rail-pane" aria-label="Stage rail">
          <h2 className="progress-rail-heading">Stages</h2>
          <StageRail stages={stages} />
        </aside>
      </div>
    </div>
  );
}
