import Link from "next/link";
import { ProgressView } from "@/components/progress/ProgressView";
import {
  DEMO_RUN_IDS,
  DemoRunId,
  buildDemoRun,
  isDemoRunId,
} from "@/lib/generation-run/fixtures";

// Per docs/scopes/generation-progress-ui.md, this route is the future home of
// the live progress polling client. Until PRs #1–#5 land it renders against
// fixture snapshots so each terminal/in-flight state is reviewable.

const DEMO_LABELS: Record<DemoRunId, string> = {
  "demo-running": "Running",
  "demo-queued": "Queued",
  "demo-succeeded": "Succeeded",
  "demo-failed": "Failed",
  "demo-canceled": "Canceled",
};

export const dynamic = "force-dynamic";

export default function GenerationRunPage({
  params,
}: {
  params: { projectId: string; runId: string };
}) {
  if (!isDemoRunId(params.runId)) {
    if (params.runId === "demo") {
      // Convenience landing — redirect-ish: render the running demo so
      // /projects/demo-project/runs/demo just works.
      const snapshot = buildDemoRun("demo-running", new Date());
      return renderShell(snapshot, params.projectId);
    }
    return (
      <div className="progress-shell">
        <header className="progress-header">
          <div>
            <p className="progress-eyebrow">Generation run</p>
            <h1 className="progress-title">Run not found</h1>
            <p className="progress-subtitle muted">
              No run with id <code>{params.runId}</code> in this project yet.
              Try one of the demo states below.
            </p>
          </div>
        </header>
        <nav className="progress-alt-runs" aria-label="Demo states">
          <span className="progress-alt-runs-label">Try a demo state:</span>
          <ul>
            {DEMO_RUN_IDS.map((id) => (
              <li key={id}>
                <Link
                  className="progress-alt-link"
                  href={`/projects/${params.projectId}/runs/${id}`}
                >
                  {DEMO_LABELS[id]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    );
  }

  const snapshot = buildDemoRun(params.runId, new Date());
  return renderShell(snapshot, params.projectId);
}

function renderShell(
  snapshot: ReturnType<typeof buildDemoRun>,
  projectId: string,
) {
  // The fixtures always emit projectId "demo-project"; reflect the URL's
  // projectId back so the header reads naturally on custom URLs.
  const run = { ...snapshot.run, projectId };
  const alternateRuns = DEMO_RUN_IDS.map((id) => ({
    runId: id,
    label: DEMO_LABELS[id],
  }));
  return (
    <ProgressView
      run={run}
      stages={snapshot.stages}
      alternateRuns={alternateRuns}
    />
  );
}

