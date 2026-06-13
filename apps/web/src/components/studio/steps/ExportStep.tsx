import { useEffect, useRef, useState } from "react";
import { Button, ButtonLink } from "../../ui/Button";
import {
  type ExportDurationPolicy,
  type ExportJob,
  type StartTimelineExportInput,
} from "../../../lib/api-client";
import {
  useStartStudioTimelineExportMutation,
  useStudioExportArtifactQuery,
  useStudioLatestTimelineQuery,
  useStudioTimelineExportQuery,
} from "../studioQueries";
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
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const [showCaptions, setShowCaptions] = useState(true);
  const [durationPolicy, setDurationPolicy] =
    useState<ExportDurationPolicy>("match_longest_media");
  const [exportError, setExportError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const completedJobId = useRef<string | null>(null);
  const activeProjectId = projectId ?? "";
  const timelineQuery = useStudioLatestTimelineQuery(activeProjectId, Boolean(projectId));
  const timeline = timelineQuery.data?.timeline ?? null;
  const timelineId = timeline?.id ?? "";
  const startExportMutation = useStartStudioTimelineExportMutation(activeProjectId, timelineId);
  const exportQuery = useStudioTimelineExportQuery(
    activeProjectId,
    jobId ?? "",
    Boolean(projectId && jobId),
  );
  const job = exportQuery.data?.job ?? null;
  const artifactId = job?.result?.artifactId ?? "";
  const artifactQuery = useStudioExportArtifactQuery(
    activeProjectId,
    artifactId,
    job?.status === "succeeded" && Boolean(artifactId),
  );
  const artifact = artifactQuery.data?.artifact ?? null;

  useEffect(() => {
    if (timeline) setShowCaptions(timeline.showCaptions ?? true);
  }, [timeline?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const duration = formatDuration(
    timeline?.segments.reduce(
      (total, segment) => total + Math.max(0, segment.sourceOutSec - segment.sourceInSec),
      0,
    ),
  );
  const canExport = Boolean(projectId && timeline && timeline.segments.length > 0 && timelineId);

  async function startExport() {
    if (!projectId || !timelineId || !canExport || startExportMutation.isPending) return;
    setExportError(null);
    setJobId(null);
    completedJobId.current = null;

    try {
      const { job: createdJob } = await startExportMutation.mutateAsync({
        format: "mp4",
        quality,
        durationPolicy,
        showCaptions,
      });
      setJobId(createdJob.id);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Could not start export.");
    }
  }

  useEffect(() => {
    if (job?.status !== "succeeded" || completedJobId.current === job.id) return;
    if (artifactId && !artifactQuery.isSuccess) return;
    completedJobId.current = job.id;
    void completeDraft?.();
  }, [artifactId, artifactQuery.isSuccess, completeDraft, job?.id, job?.status]);

  const done = job?.status === "succeeded";
  const exportBusy = startExportMutation.isPending || Boolean(job && !isTerminal(job));
  const jobError = job?.status === "failed" ? job.error?.message : null;
  const directUrl = artifact?.url ?? null;
  const timelineLoading = timelineQuery.isLoading;
  const timelineError =
    timelineQuery.error instanceof Error
      ? timelineQuery.error.message
      : timelineQuery.error
        ? "Could not load the current timeline."
        : null;
  const exportQueryError =
    exportQuery.error instanceof Error
      ? exportQuery.error.message
      : exportQuery.error
        ? "Could not refresh the export status."
        : null;
  const artifactError =
    artifactQuery.error instanceof Error
      ? artifactQuery.error.message
      : artifactQuery.error
        ? "Could not load the exported artifact."
        : null;

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
        {exportQueryError ? <p className={styles.error}>{exportQueryError}</p> : null}
        {artifactError ? <p className={styles.error}>{artifactError}</p> : null}
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
