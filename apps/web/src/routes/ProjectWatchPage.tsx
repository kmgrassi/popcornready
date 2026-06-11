import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ButtonLink } from "../components/ui/Button";
import { v1Api, type ProjectWatchMedia } from "../lib/api-client";
import styles from "./ProjectWatchPage.module.css";

type LoadState =
  | { status: "loading"; media: null; storyboardUrl: null; error: null }
  | { status: "ready"; media: ProjectWatchMedia; storyboardUrl: string; error: null }
  | { status: "empty"; media: null; storyboardUrl: string; error: null }
  | { status: "error"; media: null; storyboardUrl: null; error: Error };

export function ProjectWatchPage() {
  const { projectId } = useParams();
  const [state, setState] = useState<LoadState>({
    status: "loading",
    media: null,
    storyboardUrl: null,
    error: null,
  });

  useEffect(() => {
    if (!projectId) return;

    const controller = new AbortController();
    setState({ status: "loading", media: null, storyboardUrl: null, error: null });

    v1Api
      .getProjectWatch(projectId, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (!payload.media) {
          setState({
            status: "empty",
            media: null,
            storyboardUrl: payload.fallback.storyboardUrl,
            error: null,
          });
          return;
        }
        setState({
          status: "ready",
          media: payload.media,
          storyboardUrl: payload.fallback.storyboardUrl,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          media: null,
          storyboardUrl: null,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

    return () => controller.abort();
  }, [projectId]);

  if (!projectId) return <Navigate to="/library/projects" replace />;
  if (state.status === "empty") return <Navigate to={state.storyboardUrl} replace />;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <Link className={styles.backLink} to="/library/projects">
            Library
          </Link>
          <h1>{state.media?.projectName ?? "Watch project"}</h1>
          {state.media ? (
            <p>
              {state.media.filename}
              {formatDuration(state.media.durationSec)
                ? ` - ${formatDuration(state.media.durationSec)}`
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

      {state.status === "loading" ? (
        <section className={styles.panel} aria-busy="true">
          <div className={styles.placeholder}>Loading render...</div>
        </section>
      ) : null}

      {state.status === "error" ? (
        <section className={styles.panel}>
          <div className={styles.placeholder}>
            <strong>Unable to load this render.</strong>
            <span>{state.error.message}</span>
          </div>
        </section>
      ) : null}

      {state.status === "ready" ? (
        <section className={styles.panel} aria-label="Project render">
          <video
            className={styles.video}
            src={state.media.url}
            poster={state.media.posterUrl}
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
