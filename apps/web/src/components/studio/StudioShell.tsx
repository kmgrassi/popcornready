import { useEffect, useState } from "react";
import type { Project } from "@popcorn/shared/types";
import {
  GENERATION_STAGE_LABELS,
  type GateableGenerationStageType,
} from "@popcorn/shared/v1/types";
import { DEFAULT_DURATION_POLICY } from "@popcorn/shared/audio-alignment";
import { Button } from "../ui/Button";
import { PreviewPanel } from "../editor/PreviewPanel";
import { SidebarPanel } from "../editor/SidebarPanel";
import { PreviewPlayer } from "../PreviewPlayer";
import { v1Api } from "../../lib/api-client";
import { StudioEmptyState } from "./StudioEmptyState";
import { StudioStepper } from "./StudioStepper";
import { GenerationChecklist } from "./GenerationChecklist";
import { useStudioFlow, type BriefDraft, type StudioStep } from "./useStudioFlow";
import { BriefStep } from "./steps/BriefStep";
import { SourceFootageStep } from "./steps/SourceFootageStep";
import { StoryDirectionStep } from "./steps/StoryDirectionStep";
import { GenerateStep } from "./steps/GenerateStep";
import { ReviewStep } from "./steps/ReviewStep";
import { ExportStep } from "./steps/ExportStep";
import styles from "./StudioShell.module.css";

export interface StudioShellProps {
  /** Seed the brief draft, e.g. from `?goal=`/`?length=` query params. */
  initialBrief?: Partial<BriefDraft>;
}

/**
 * StudioShell — the Studio wizard backbone (PR 1).
 *
 * Drives the `initial → generating → review` state machine and renders, per
 * state: the empty state + stepper + active step (initial), the calm status
 * checklist (generating), and the preview + timeline (review). Steps plug in by
 * implementing `StepProps`; the shell owns navigation and the run lifecycle.
 */
export function StudioShell({ initialBrief }: StudioShellProps) {
  const flow = useStudioFlow({ initialBrief });
  const [started, setStarted] = useState(false);

  // Before the user starts, show the empty state. Once they click "Start new
  // video" we enter the Brief step; the stepper + step body take over.
  if (flow.state === "initial" && !started) {
    return (
      <main className={styles.shell}>
        <StudioEmptyState onStart={() => setStarted(true)} />
      </main>
    );
  }

  if (flow.state === "generating") {
    const gate = flow.run?.reviewGate ?? null;
    return (
      <main className={styles.shell}>
        <StudioStepper step={flow.step} />
        <section className={styles.generating}>
          <h2 className={styles.generatingHeading}>Generating your rough cut</h2>
          <p className="muted">
            This runs autonomously — we'll surface a preview to review as soon as
            it's ready.
          </p>
          <GenerationChecklist run={flow.run} stages={flow.stages} />
          {gate ? (
            <GateCard
              stageType={gate.stageType}
              onApprove={() => flow.approveGate()}
              onReject={() => flow.rejectGate()}
            />
          ) : null}
          {flow.error ? <p className="new-project-error">{flow.error}</p> : null}
        </section>
      </main>
    );
  }

  if (flow.state === "review") {
    return (
      <main className={styles.shell}>
        <StudioStepper step={flow.step} onStepClick={flow.goTo} />
        <ReviewState projectId={flow.projectId} />
      </main>
    );
  }

  // initial + started: the wizard's setup steps.
  return (
    <main className={styles.shell}>
      <div className={styles.cta}>
        <Button variant="cta" size="lg" onClick={() => flow.goTo("brief")}>
          Start new video
        </Button>
      </div>
      <StudioStepper step={flow.step} onStepClick={flow.goTo} />
      <section className={styles.stepBody}>
        <ActiveStep step={flow.step} flow={flow} />
      </section>
    </main>
  );
}

function ActiveStep({
  step,
  flow,
}: {
  step: StudioStep;
  flow: ReturnType<typeof useStudioFlow>;
}) {
  const stepProps = {
    draft: flow.brief,
    update: flow.update,
    next: flow.next,
    back: flow.back,
  };

  switch (step) {
    case "brief":
      return <BriefStep {...stepProps} />;
    case "footage":
      return <SourceFootageStep {...stepProps} />;
    case "story":
      return <StoryDirectionStep {...stepProps} />;
    case "generate":
      return (
        <GenerateStep
          {...stepProps}
          error={flow.error}
          onGenerate={flow.startGeneration}
        />
      );
    case "review":
      return <ReviewStep {...stepProps} />;
    case "export":
      return <ExportStep {...stepProps} />;
    default:
      return null;
  }
}

/**
 * GateCard — approve/reject controls for a paused mid-run review gate. Keeps the
 * gate actionable inside the `generating` view so gated runs aren't stranded.
 * (A richer feedback box lands with PR 6 / the stepwise-story-generation scope.)
 */
function GateCard({
  stageType,
  onApprove,
  onReject,
}: {
  stageType: GateableGenerationStageType;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className={styles.gate}>
      <p className={styles.gateHeading}>
        {GENERATION_STAGE_LABELS[stageType]} is ready for your review.
      </p>
      <div className={styles.gateActions}>
        <Button variant="cta" onClick={onApprove}>
          Approve &amp; continue
        </Button>
        <Button variant="secondary" onClick={onReject}>
          Reject / regenerate
        </Button>
      </div>
    </div>
  );
}

/**
 * ReviewState — interim review layout. Reuses the existing PreviewPanel
 * (preview) and SidebarPanel (timeline) until PR 6 re-homes them under
 * `components/studio/`. Loads the studio project so the timeline renders real
 * segments once one exists.
 *
 * NOTE: full rough-cut loading (resolving the run's generated timeline/clips for
 * `projectId`) is PR 6's scope and is also gated on the generation-engine media
 * stages — today `getStudioProject()` projects `timeline: null`, so the panels
 * fall back to the PR 5 placeholder. This state is only reached on terminal
 * success, so it reads as "ready" rather than mid-run.
 */
function ReviewState({ projectId }: { projectId?: string }) {
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    let cancelled = false;
    v1Api
      .getStudioProject()
      .then((data) => {
        if (!cancelled) setProject(data.project);
      })
      .catch(() => {
        if (!cancelled) setProject(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const clips = project?.clips ?? [];
  const timeline = project?.timeline ?? null;
  const clipById = Object.fromEntries(clips.map((clip) => [clip.id, clip]));

  return (
    <section className={styles.review}>
      <header className={styles.reviewHeader}>
        <h2 className={styles.generatingHeading}>Your rough cut is ready</h2>
        <p className="muted">
          Review the preview and timeline below. Inline editing arrives with the
          review step.
        </p>
      </header>
      <PreviewPanel
        Preview={PreviewPlayer}
        audioClips={[]}
        busy={false}
        createdVideos={[]}
        durationPolicy={DEFAULT_DURATION_POLICY}
        exportResult={null}
        galleryLoading={false}
        loadedVideoThumbs={{}}
        plan={project?.plan ?? undefined}
        selectedAudioClipId=""
        setDurationPolicy={() => {}}
        setLoadedVideoThumbs={() => {}}
        setSelectedAudioClipId={() => {}}
        timeline={timeline}
        clips={clips}
        onAlignAudio={() => {}}
        onExport={() => {}}
        onRefreshCreatedVideos={() => {}}
        showActions={false}
      />
      <SidebarPanel
        busy={false}
        clipById={clipById}
        message=""
        project={project}
        setMessage={() => {}}
        timeline={timeline}
        onRevise={() => {}}
        showActions={false}
      />
    </section>
  );
}
