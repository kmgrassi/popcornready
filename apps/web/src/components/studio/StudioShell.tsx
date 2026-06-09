import { useState } from "react";
import {
  GENERATION_STAGE_LABELS,
  type GateableGenerationStageType,
} from "@popcorn/shared/v1/types";
import { Button } from "../ui/Button";
import { StatusChecklist } from "../ui/StatusChecklist";
import { StudioEmptyState } from "./StudioEmptyState";
import { StudioStepper } from "./StudioStepper";
import { buildChecklistItems } from "./statusChecklist";
import { useStudioFlow, type BriefDraft, type StudioStep } from "./useStudioFlow";
import { BriefStep } from "./steps/BriefStep";
import { SourceFootageStep } from "./steps/SourceFootageStep";
import { StoryDirectionStep } from "./steps/StoryDirectionStep";
import { GenerateStep } from "./steps/GenerateStep";
import { ReviewStep as ReviewSetupStep } from "./steps/ReviewStep";
import { ReviewStep } from "./ReviewStep";
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
    const items = buildChecklistItems(flow.stages, flow.run?.status ?? "queued");
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
          <StatusChecklist items={items} />
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
    const stepProps = {
      draft: flow.brief,
      projectId: flow.projectId,
      update: flow.update,
      next: flow.next,
      back: flow.back,
    };

    return (
      <main className={styles.shell}>
        <StudioStepper step={flow.step} onStepClick={flow.goTo} />
        {flow.step === "export" ? (
          <section className={styles.stepBody}>
            <ExportStep {...stepProps} />
          </section>
        ) : (
          <ReviewStep
            project={flow.reviewProject}
            timeline={flow.reviewTimeline}
            timelineId={flow.reviewTimelineId}
            clips={flow.reviewClips}
            segmentNotes={flow.reviewSegmentNotes}
            loading={flow.reviewLoading}
            error={flow.reviewError ?? flow.error}
            onFeedback={flow.requestRevision}
            onSegmentChange={flow.updateReviewSegment}
            onSegmentNoteChange={flow.updateReviewSegmentNote}
            onExport={() => flow.goTo("export")}
          />
        )}
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
    projectId: flow.projectId,
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
      return <ReviewSetupStep {...stepProps} />;
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
