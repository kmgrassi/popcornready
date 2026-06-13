import { Link, useParams } from "react-router-dom";
import { StoryboardEditor } from "../components/storyboard/StoryboardEditor";
import { useStoryboardPageQuery } from "../lib/project-queries";

// Storyboard editing surface for a project. The project-specific route loads
// the requested project; the dashboard route falls back to the current studio
// project selector until the project list has first-class storyboard links.

export function StoryboardPage() {
  const { projectId: routeProjectId } = useParams();
  const storyboardQuery = useStoryboardPageQuery(routeProjectId ?? null);
  const projectId = storyboardQuery.data?.projectId ?? null;
  const storyboard = storyboardQuery.data?.storyboard ?? null;
  const hasLoadedData = storyboardQuery.data !== undefined;
  const error = !hasLoadedData && storyboardQuery.error
    ? storyboardQuery.error instanceof Error
      ? storyboardQuery.error.message
      : "Failed to load the storyboard."
    : projectId
      ? null
      : !storyboardQuery.isLoading
        ? "No project found for storyboard editing."
        : null;

  if (storyboardQuery.isLoading) {
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
