import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ProjectStoryboard } from "@popcorn/shared/v1/types";
import { StoryboardEditor } from "../components/storyboard/StoryboardEditor";
import { v1Api } from "../lib/api-client";

// Storyboard editing surface for a project. The project-specific route loads
// the requested project; the dashboard route falls back to the current studio
// project selector until the project list has first-class storyboard links.

export function StoryboardPage() {
  const { projectId: routeProjectId } = useParams();
  const [projectId, setProjectId] = useState<string | null>(
    routeProjectId ?? null
  );
  const [storyboard, setStoryboard] = useState<ProjectStoryboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProjectId(routeProjectId ?? null);

    const request = routeProjectId
      ? v1Api.getProjectStoryboard(routeProjectId).then((res) => ({
          projectId: routeProjectId,
          storyboard: res.storyboard,
        }))
      : v1Api.getStudioProject().then(async (res) => {
          if (!res.project) {
            return { projectId: null, storyboard: null };
          }
          const storyboardRes = await v1Api.getProjectStoryboard(res.project.id);
          return { projectId: res.project.id, storyboard: storyboardRes.storyboard };
        });

    request
      .then((result) => {
        if (cancelled) return;
        setProjectId(result.projectId);
        setStoryboard(result.storyboard);
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
        <p className="muted">Loading storyboard...</p>
      </main>
    );
  }

  if (error || !projectId) {
    return (
      <main className="sb-shell">
        <h1>Storyboard</h1>
        <p className="muted">{error ?? "No project found for this storyboard."}</p>
        <Link className="sb-btn" to="/studio">
          Back to studio
        </Link>
      </main>
    );
  }

  return <StoryboardEditor projectId={projectId} initialStoryboard={storyboard} />;
}
