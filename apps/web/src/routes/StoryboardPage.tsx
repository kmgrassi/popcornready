import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Asset } from "@popcorn/shared/assets/types";
import type { EditPlan } from "@popcorn/shared/types";
import { StoryboardEditor } from "../components/storyboard/StoryboardEditor";
import { v1Api } from "../lib/api-client";

// Storyboard editing surface for a project. The project-specific route loads
// the requested project; the dashboard route falls back to the current studio
// project selector until the project list has first-class storyboard links.

function emptyPlan(): EditPlan {
  return {
    targetLengthSec: 30,
    // The editor exposes no style field, so a scaffolded plan must carry a
    // non-empty default or the first Save fails with no way to recover in the UI.
    style: "fast-paced social ad",
    aspectRatio: "9:16",
    scenes: [],
  };
}

export function StoryboardPage() {
  const { projectId: routeProjectId } = useParams();
  const [projectId, setProjectId] = useState<string | null>(
    routeProjectId ?? null
  );
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProjectId(routeProjectId ?? null);

    const request = routeProjectId
      ? v1Api.getProject(routeProjectId).then((res) => ({
          projectId: res.project.id,
          plan: res.project.plan,
          assets: [] as Asset[],
        }))
      : v1Api.getStoryboard();

    request
      .then((result) => {
        if (cancelled) return;
        setProjectId(result.projectId);
        setPlan(result.plan ?? emptyPlan());
        setAssets(result.assets);
        setError(result.projectId ? null : "No project found for storyboard editing.");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load the storyboard.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [routeProjectId]);

  if (loading) {
    return (
      <main className="sb-shell">
        <h1>Storyboard</h1>
        <p className="muted">Loading plan...</p>
      </main>
    );
  }

  if (error || !projectId || !plan) {
    return (
      <main className="sb-shell">
        <h1>Storyboard</h1>
        <p className="muted">{error ?? "No plan found for this project."}</p>
        <Link className="sb-btn" to="/studio">
          Back to studio
        </Link>
      </main>
    );
  }

  return <StoryboardEditor projectId={projectId} initialPlan={plan} assets={assets} />;
}
