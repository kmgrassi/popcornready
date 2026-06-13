import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GENERATION_STAGE_LABELS,
  type GateableGenerationStageType,
} from "@popcorn/shared/v1/types";
import { useNavigate } from "react-router-dom";
import { Button } from "../ui/Button";
import { StatusChecklist } from "../ui/StatusChecklist";
import { StudioEmptyState } from "./StudioEmptyState";
import { StudioStepper } from "./StudioStepper";
import { buildChecklistItems } from "./statusChecklist";
import {
  EMPTY_BRIEF_DRAFT,
  useStudioFlow,
  type BriefDraft,
  type StudioStep,
} from "./useStudioFlow";
import { BriefStep } from "./steps/BriefStep";
import { SourceFootageStep } from "./steps/SourceFootageStep";
import { StoryDirectionStep } from "./steps/StoryDirectionStep";
import { GenerateStep } from "./steps/GenerateStep";
import { ReviewStep as ReviewSetupStep } from "./steps/ReviewStep";
import { ReviewStep } from "./ReviewStep";
import { ExportStep } from "./steps/ExportStep";
import {
  type StudioDraftPayload,
} from "../../lib/draftStore";
import {
  useCreateStudioDraftMutation,
  useDeleteStudioDraftMutation,
  useStudioDraftQuery,
  useStudioDraftsQuery,
} from "../../lib/draftStoreQuery";
import styles from "./StudioShell.module.css";

const LOCAL_DRAFT_ID = "local";

function studioDraftPath({
  draftId,
  step,
  openPanel,
  started,
}: {
  draftId?: string;
  step: StudioStep;
  openPanel?: string;
  started?: boolean;
}) {
  const params = new URLSearchParams();
  if (draftId) params.set("draft", draftId);
  if (started) params.set("start", "1");
  if (step !== "brief") params.set("step", step);
  if (openPanel) params.set("panel", openPanel);
  const query = params.toString();
  return query ? `/studio?${query}` : "/studio";
}

export interface StudioShellProps {
  /** Seed the brief draft, e.g. from `?goal=`/`?length=` query params. */
  initialBrief?: Partial<BriefDraft>;
  /** Seed the active step, e.g. from palette deep links. */
  initialStep?: StudioStep;
  /** Skip the empty state when the route is opened for a specific action. */
  initialStarted?: boolean;
  /** Optional panel key the active step should open by default. */
  openPanel?: string;
  /** Optional saved draft id from `/studio?draft=:id`. */
  draftId?: string | null;
}

/**
 * StudioShell — the Studio wizard backbone (PR 1).
 *
 * Drives the `initial → generating → review` state machine and renders, per
 * state: the empty state + stepper + active step (initial), the calm status
 * checklist (generating), and the preview + timeline (review). Steps plug in by
 * implementing `StepProps`; the shell owns navigation and the run lifecycle.
 */
export function StudioShell({
  initialBrief,
  initialStep,
  initialStarted = false,
  openPanel,
  draftId,
}: StudioShellProps) {
  const navigate = useNavigate();
  const seededBrief = useMemo(
    () => ({
      ...initialBrief,
    }),
    [initialBrief],
  );
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [initialPayload, setInitialPayload] = useState<StudioDraftPayload | null>(null);
  const [pendingDraftId, setPendingDraftId] = useState<string | null>(null);
  const [draftActionError, setDraftActionError] = useState<string | null>(null);
  const [flowKey, setFlowKey] = useState(0);
  const autoStartRequestedRef = useRef(false);
  const draftsQuery = useStudioDraftsQuery();
  const draftQuery = useStudioDraftQuery(pendingDraftId);
  const createDraftMutation = useCreateStudioDraftMutation();
  const deleteDraftMutation = useDeleteStudioDraftMutation();
  const drafts = draftsQuery.data ?? [];
  const draftsLoading = draftsQuery.isLoading;
  const draftsError =
    draftActionError ??
    (draftsQuery.error instanceof Error ? draftsQuery.error.message : null) ??
    (draftQuery.error instanceof Error ? draftQuery.error.message : null);

  const openDraft = useCallback(
    (nextDraftId: string) => {
      setDraftActionError(null);
      setPendingDraftId(nextDraftId);
    },
    [],
  );

  useEffect(() => {
    if (draftQuery.isFetching || draftQuery.error) return;
    const record = draftQuery.data;
    if (!record || pendingDraftId !== record.draftId) return;
    setActiveDraftId(record.draftId);
    setInitialPayload(record.payload);
    setFlowKey((current) => current + 1);
    setPendingDraftId(null);
    navigate(`/studio?draft=${encodeURIComponent(record.draftId)}`, { replace: true });
  }, [draftQuery.data, draftQuery.error, draftQuery.isFetching, navigate, pendingDraftId]);

  useEffect(() => {
    if (!draftId || activeDraftId === draftId) return;
    openDraft(draftId);
  }, [activeDraftId, draftId, openDraft]);

  const startNewDraft = useCallback(async (step: StudioStep = "brief") => {
    setDraftActionError(null);
    try {
      const record = await createDraftMutation.mutateAsync({
        draft: { ...EMPTY_BRIEF_DRAFT, ...seededBrief },
        step,
      });
      setActiveDraftId(record.draftId);
      setInitialPayload(record.payload);
      setFlowKey((current) => current + 1);
      navigate(studioDraftPath({ draftId: record.draftId, step, openPanel }), {
        replace: true,
      });
    } catch {
      setActiveDraftId(LOCAL_DRAFT_ID);
      setInitialPayload(null);
      setFlowKey((current) => current + 1);
      navigate(studioDraftPath({ step, openPanel, started: initialStarted }), {
        replace: true,
      });
    }
  }, [createDraftMutation, initialStarted, navigate, openPanel, seededBrief]);

  useEffect(() => {
    if (!initialStarted || draftId) {
      autoStartRequestedRef.current = false;
      return;
    }
    if (activeDraftId || autoStartRequestedRef.current) return;
    autoStartRequestedRef.current = true;
    void startNewDraft(initialStep ?? "brief");
  }, [activeDraftId, draftId, initialStarted, initialStep, startNewDraft]);

  async function removeDraft(nextDraftId: string) {
    setDraftActionError(null);
    try {
      await deleteDraftMutation.mutateAsync(nextDraftId);
      if (nextDraftId === activeDraftId) {
        setActiveDraftId(null);
        setInitialPayload(null);
        setPendingDraftId(null);
        navigate("/studio", { replace: true });
      }
    } catch (error) {
      setDraftActionError(error instanceof Error ? error.message : "Could not delete draft.");
    }
  }

  if (!activeDraftId) {
    return (
      <main className={styles.shell}>
        <StudioEmptyState
          drafts={drafts}
          loading={draftsLoading}
          error={draftsError}
          onResume={(id) => void openDraft(id)}
          onDelete={(id) => void removeDraft(id)}
        />
      </main>
    );
  }

  return (
    <StudioFlowView
      key={`${activeDraftId}-${flowKey}`}
      draftId={activeDraftId}
      initialBrief={seededBrief}
      initialPayload={initialPayload}
      initialStep={initialStep}
      openPanel={openPanel}
    />
  );
}

function StudioFlowView({
  draftId,
  initialBrief,
  initialPayload,
  initialStep,
  openPanel,
}: {
  draftId: string;
  initialBrief?: Partial<BriefDraft>;
  initialPayload: StudioDraftPayload | null;
  initialStep?: StudioStep;
  openPanel?: string;
}) {
  const navigate = useNavigate();
  const flow = useStudioFlow({
    initialBrief,
    draftId: draftId === LOCAL_DRAFT_ID ? undefined : draftId,
    initialPayload,
    initialStep,
  });
  const goToStep = flow.goTo;

  useEffect(() => {
    if (initialStep) goToStep(initialStep);
  }, [goToStep, initialStep]);

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
      completeDraft: flow.completeDraft,
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
      <StudioStepper
        step={flow.step}
        onStepClick={flow.goTo}
        clickableThroughStep="generate"
      />
      <section className={styles.stepBody}>
        <ActiveStep
          key={`${flow.step}:${openPanel ?? ""}`}
          step={flow.step}
          flow={flow}
          openPanel={openPanel}
          onGenerationStarted={(projectId, runId) => {
            const params = new URLSearchParams();
            if (draftId !== LOCAL_DRAFT_ID) params.set("studioDraft", draftId);
            const query = params.toString();
            navigate(
              `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}${
                query ? `?${query}` : ""
              }`,
            );
          }}
        />
      </section>
    </main>
  );
}

function ActiveStep({
  step,
  flow,
  openPanel,
  onGenerationStarted,
}: {
  step: StudioStep;
  flow: ReturnType<typeof useStudioFlow>;
  openPanel?: string;
  onGenerationStarted?: (projectId: string, runId: string) => void;
}) {
  const stepProps = {
    draft: flow.brief,
    projectId: flow.projectId,
    update: flow.update,
    next: flow.next,
    back: flow.back,
    completeDraft: flow.completeDraft,
  };

  switch (step) {
    case "brief":
      return <BriefStep {...stepProps} openPanel={openPanel} />;
    case "footage":
      return <SourceFootageStep {...stepProps} />;
    case "story":
      return <StoryDirectionStep {...stepProps} />;
    case "generate":
      return (
        <GenerateStep
          {...stepProps}
          error={flow.error}
          onGenerate={async () => {
            const result = await flow.startGeneration();
            onGenerationStarted?.(result.projectId, result.runId);
          }}
          onEditBrief={() => flow.goTo("brief")}
          openPanel={openPanel}
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
