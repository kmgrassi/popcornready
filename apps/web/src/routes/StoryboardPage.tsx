import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { EditPlan } from "@popcorn/shared/types";
import { StoryboardEditor } from "../components/storyboard/StoryboardEditor";
import { v1Api } from "../lib/api-client";

// Storyboard surface for a project (Storyboard & Scenes — PR6 editing). PR5 owns
// the richer read-only view + tile artifacts; this page loads the project's
// editable plan and mounts the editor so a user can restructure scenes/beats and
// regenerate single tiles. If the project has no plan yet, it scaffolds an empty
// single-scene plan to edit from.

function emptyPlan(): EditPlan {
  return {
    targetLengthSec: 30,
    style: "",
    aspectRatio: "9:16",
    scenes: [],
    beats: [],
  };
}

export function StoryboardPage() {
  const { projectId } = useParams();
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    v1Api
      .getProject(projectId)
      .then((res) => {
        if (cancelled) return;
        setPlan(res.project.plan ?? emptyPlan());
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!projectId) {
    return (
      <main className="sb-shell">
        <h1>Storyboard</h1>
        <p className="muted">This URL is missing a project id.</p>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="sb-shell">
        <h1>Storyboard</h1>
        <p className="muted">Loading plan…</p>
      </main>
    );
  }

  if (error || !plan) {
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

  return <StoryboardEditor projectId={projectId} initialPlan={plan} />;
}
