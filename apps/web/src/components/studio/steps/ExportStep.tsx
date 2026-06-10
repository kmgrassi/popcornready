import { useEffect, useState } from "react";
import type { VersionedTimeline } from "@popcorn/shared/v1/types";
import { Button, ButtonLink } from "../../ui/Button";
import {
  v1Api,
  type ExportDurationPolicy,
  type ExportJob,
  type ExportRenderArtifact,
  type StartTimelineExportInput,
} from "../../../lib/api-client";
import type { StepProps } from "../useStudioFlow";
import { StepShell } from "./StepShell";
import styles from "./ExportStep.module.css";

type ExportQuality = StartTimelineExportInput["quality"];

const QUALITY_OPTIONS: Array<{
  value: ExportQuality;
  label: string;
  description: string;
}> = [
  {
    value: "standard",
    label: "Standard",
    description: "Balanced render for review links and social publishing.",
  },
  {
    value: "draft",
    label: "Draft",
    description: "Faster render for quick approvals.",
  },
  {
    value: "high",
    label: "High",
    description: "Best quality for the final downloadable file.",
  },
];

const DURATION_POLICY_OPTIONS: Array<{
  value: ExportDurationPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "match_longest_media",
    label: "Match longest media",
    description: "Extends the render if narration or audio runs long.",
  },
  {
    value: "timeline_only",
    label: "Timeline only",
    description: "Exports exactly the current timeline length.",
  },
  {
    value: "fail_on_mismatch",
    label: "Require aligned audio",
    description: "Stops export if audio and timeline durations differ.",
  },
];

function isTerminal(job: ExportJob) {
  return job.status === "succeeded" || job.status === "failed" || job.status === "canceled";
}

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) return null;
  const totalSeconds = Math.max(0, Math.round(seconds ?? 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * ExportStep — step 6. Keeps the shared StepProps-only contract while loading
 * the latest v1 project timeline internally, then starts the mounted v1 timeline
 * export route and resolves the resulting artifact for the done state.
 */
export function ExportStep({ back, projectId, completeDraft }: StepProps) {
  const [timeline, setTimeline] = useState<VersionedTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(Boolean(projectId));
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const [showCaptions, setShowCaptions] = useState(true);
  const [durationPolicy, setDurationPolicy] =
    useState<ExportDurationPolicy>("match_longest_media");
  const [job, setJob] = useState<ExportJob | null>(null);
  const [artifact, setArtifact] = useState<ExportRenderArtifact | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setTimeline(null);
      setTimelineLoading(false);
      setTimelineError(null);
      return;
    }

    let cancelled = false;
    setTimelineLoading(true);
    setTimelineError(null);

    v1Api
      .getLatestProjectTimeline(projectId)
      .then(({ timeline: loadedTimeline }) => {
        if (cancelled) return;
        setTimeline(loadedTimeline);
        setShowCaptions(loadedTimeline?.showCaptions ?? true);
      })
      .catch((error) => {
        if (cancelled) return;
        setTimelineError(
          error instanceof Error ? error.message : "Could not load the current timeline.",
        );
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const timelineId = timeline?.id ?? null;
  const duration = formatDuration(
    timeline?.segments.reduce(
      (total, segment) => total + Math.max(0, segment.sourceOutSec - segment.sourceInSec),
      0,
    ),
  );
  const canExport = Boolean(projectId && timeline && timeline.segments.length > 0 && timelineId);

  async function resolveArtifact(nextJob: ExportJob) {
    if (!projectId || !nextJob.result?.artifactId) return;
    const { artifact: loadedArtifact } = await v1Api.getExportArtifact(
      projectId,
      nextJob.result.artifactId,
    );
    setArtifact(loadedArtifact);
  }

  async function pollExport(nextJob: ExportJob) {
    if (!projectId) return;
    setJob(nextJob);

    if (nextJob.status === "succeeded") {
      await resolveArtifact(nextJob);
      await completeDraft?.();
      return;
    }

    if (isTerminal(nextJob)) return;

    window.setTimeout(async () => {
      try {
        const { job: updatedJob } = await v1Api.getTimelineExport(projectId, nextJob.id);
        await pollExport(updatedJob);
      } catch (error) {
        setExportError(
          error instanceof Error ? error.message : "Could not refresh the export status.",
        );
      }
    }, 2000);
  }

  async function startExport() {
    if (!projectId || !timelineId || !canExport || submitting) return;
    setSubmitting(true);
    setExportError(null);
    setArtifact(null);

    try {
      const { job: createdJob } = await v1Api.startTimelineExport(projectId, timelineId, {
        format: "mp4",
        quality,
        durationPolicy,
        showCaptions,
      });
      await pollExport(createdJob);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Could not start export.");
    } finally {
      setSubmitting(false);
    }
  }

  const done = job?.status === "succeeded";
  const exportBusy = submitting || Boolean(job && !isTerminal(job));
  const jobError = job?.status === "failed" ? job.error?.message : null;
  const directUrl = artifact?.url ?? null;

  return (
    <StepShell
      heading="Export"
      description="Render the approved cut as an MP4 and send it to Outputs."
      onBack={back}
    >
      <div className={styles.form}>
        <fieldset className={styles.group} disabled={exportBusy}>
          <legend>Format</legend>
          <label className={styles.option}>
            <input type="radio" checked readOnly />
            <span>
              <strong>MP4</strong>
              <small>H.264 video for social platforms and download links.</small>
            </span>
          </label>
        </fieldset>

        <fieldset className={styles.group} disabled={exportBusy}>
          <legend>Quality</legend>
          <div className={styles.optionGrid}>
            {QUALITY_OPTIONS.map((option) => (
              <label className={styles.option} key={option.value}>
                <input
                  type="radio"
                  name="export-quality"
                  value={option.value}
                  checked={quality === option.value}
                  onChange={() => setQuality(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.group} disabled={exportBusy}>
          <legend>Captions</legend>
          <label className={styles.option}>
            <input
              type="checkbox"
              checked={showCaptions}
              onChange={(event) => setShowCaptions(event.target.checked)}
            />
            <span>
              <strong>Burn captions into the video</strong>
              <small>Uses the captions already generated on the timeline.</small>
            </span>
          </label>
        </fieldset>

        <fieldset className={styles.group} disabled={exportBusy}>
          <legend>Duration</legend>
          <select
            value={durationPolicy}
            onChange={(event) =>
              setDurationPolicy(event.target.value as ExportDurationPolicy)
            }
          >
            {DURATION_POLICY_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className={styles.help}>
            {
              DURATION_POLICY_OPTIONS.find((option) => option.value === durationPolicy)
                ?.description
            }
          </p>
        </fieldset>

        <div className={styles.summary}>
          <span>Current cut</span>
          <strong>{duration ?? "No timeline loaded"}</strong>
        </div>

        {timelineLoading ? <p className={styles.status}>Loading the current cut...</p> : null}
        {timelineError ? <p className={styles.error}>{timelineError}</p> : null}
        {!projectId ? (
          <p className={styles.error}>Generate a rough cut before exporting.</p>
        ) : null}
        {!timelineLoading && !timelineError && projectId && !canExport ? (
          <p className={styles.error}>
            Generate or load a rough cut with a timeline before exporting.
          </p>
        ) : null}
        {exportError ? <p className={styles.error}>{exportError}</p> : null}
        {jobError ? <p className={styles.error}>{jobError}</p> : null}

        {done ? (
          <div className={styles.done}>
            <strong>Export created</strong>
            <span>
              {directUrl
                ? "Your MP4 is ready to open."
                : "The export is recorded in Outputs. Rendering may still be pending."}
            </span>
            <div className={styles.actions}>
              {directUrl ? (
                <a className={styles.linkButton} href={directUrl}>
                  Open MP4
                </a>
              ) : null}
              <ButtonLink variant="secondary" to="/outputs">
                View Outputs
              </ButtonLink>
            </div>
          </div>
        ) : (
          <div className={styles.actions}>
            <Button
              variant="cta"
              size="lg"
              onClick={startExport}
              disabled={!canExport || exportBusy || timelineLoading}
            >
              {exportBusy ? "Exporting..." : "Export"}
            </Button>
            <ButtonLink variant="secondary" to="/outputs">
              Outputs
            </ButtonLink>
          </div>
        )}
      </div>
    </StepShell>
  );
}
