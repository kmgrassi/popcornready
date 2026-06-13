import { Link, Navigate, useParams } from "react-router-dom";
import { ButtonLink } from "../components/ui/Button";
import { useProjectWatchQuery } from "../lib/project-queries";
import styles from "./ProjectWatchPage.module.css";

export function ProjectWatchPage() {
  const { projectId } = useParams();
  const watchQuery = useProjectWatchQuery(projectId ?? null);
  const media = watchQuery.data?.media ?? null;
  const storyboardUrl = watchQuery.data?.fallback.storyboardUrl ?? null;
  const error =
    watchQuery.error instanceof Error
      ? watchQuery.error
      : watchQuery.error
        ? new Error(String(watchQuery.error))
        : null;

  if (!projectId) return <Navigate to="/library/projects" replace />;
  if (!watchQuery.isLoading && !error && !media && storyboardUrl) {
    return <Navigate to={storyboardUrl} replace />;
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <Link className={styles.backLink} to="/library/projects">
            Library
          </Link>
          <h1>{media?.projectName ?? "Watch project"}</h1>
          {media ? (
            <p>
              {media.filename}
              {formatDuration(media.durationSec)
                ? ` - ${formatDuration(media.durationSec)}`
                : ""}
            </p>
          ) : (
            <p>Loading the selected render.</p>
          )}
        </div>
        <ButtonLink
          variant="secondary"
          to={`/projects/${encodeURIComponent(projectId)}/storyboard`}
        >
          Storyboard
        </ButtonLink>
      </header>

      {watchQuery.isLoading ? (
        <section className={styles.panel} aria-busy="true">
          <div className={styles.placeholder}>Loading render...</div>
        </section>
      ) : null}

      {error ? (
        <section className={styles.panel}>
          <div className={styles.placeholder}>
            <strong>Unable to load this render.</strong>
            <span>{error.message}</span>
          </div>
        </section>
      ) : null}

      {media ? (
        <section className={styles.panel} aria-label="Project render">
          <video
            className={styles.video}
            src={media.url}
            poster={media.posterUrl}
            controls
            playsInline
            preload="metadata"
            autoFocus
          />
        </section>
      ) : null}
    </main>
  );
}

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) return null;
  const totalSeconds = Math.max(0, Math.round(seconds ?? 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
