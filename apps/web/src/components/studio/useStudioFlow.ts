// useStudioFlow — the Studio wizard's state machine and shared contract.
//
// This is the seam wave-3 step PRs (Brief, Footage, Story, Generate, Review,
// Export) build against. Steps never reach into siblings: they read/patch the
// accumulated `BriefDraft` and call `next()`/`back()`. The hook owns the
// `initial → generating → review` machine, the active step, run creation, and
// the polling that drives the generation checklist + review handoff.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Clip, Project, Timeline, TimelineSegment } from "@popcorn/shared/types";
import type {
  AspectRatio,
  GateableGenerationStageType,
  GenerationRun,
  GenerationStage,
} from "@popcorn/shared/v1/types";
import type { StoryContext } from "@popcorn/shared/types";
import { v1Api } from "../../lib/api-client";
import { deleteDraft, saveDraft, type StudioDraftPayload } from "../../lib/draftStore";
import type { GenerationRunResultArtifact } from "../../lib/v1/generation-runs/status";
import { createAndStartRun } from "../../lib/startRun";
import type { SelectedFootage } from "../../lib/upload";

// --- State / step vocabularies ---------------------------------------------

export type StudioState = "initial" | "generating" | "review";
export type StudioStep =
  | "brief"
  | "footage"
  | "story"
  | "generate"
  | "review"
  | "export";

/** Ordered steps the stepper renders; index drives the active highlight. */
export const STUDIO_STEPS: StudioStep[] = [
  "brief",
  "footage",
  "story",
  "generate",
  "review",
  "export",
];

// Reuse the shared brief vocabularies so steps stay aligned with the V1 brief.
export type Platform = NonNullable<StoryContext["platform"]>;
export type StoryFormat = NonNullable<StoryContext["format"]>;
export type FootageChoice = "prompt_only" | "upload";
export type FootageMode = "asset_driven" | "hybrid";
export type SeedKind = "image" | "video";

/**
 * BriefDraft — the superset of every step's fields, accumulated across the
 * wizard. Each step reads what it needs and patches via `update()`. New fields
 * a future step needs are added here (and to `EMPTY_BRIEF_DRAFT`), so the
 * contract stays one object.
 */
export interface BriefDraft {
  // Brief (step 1) — the < 5 visible controls.
  goal: string;
  targetLengthSec: number;
  aspectRatio: AspectRatio;
  projectName: string;

  // Source footage (step 2).
  footageChoice: FootageChoice;
  footageMode: FootageMode;
  selectedFootage: SelectedFootage[];

  // Advanced creative direction (collapsed in Brief + Story steps).
  audience: string;
  platform: Platform;
  format: StoryFormat;
  hook: string;
  bestVisual: string;
  bigIdea: string;
  payoff: string;
  accuracyNote: string;
  style: string;
  callToAction: string;

  // Generate-step config (seed + captions + review gates).
  provider: string;
  seedKind: SeedKind;
  seedSize: string;
  showCaptions: boolean;
  reviewGates: GateableGenerationStageType[];
}

/** Initial draft — calm defaults; the empty state seeds goal/length over this. */
export const EMPTY_BRIEF_DRAFT: BriefDraft = {
  goal: "",
  targetLengthSec: 30,
  aspectRatio: "9:16",
  projectName: "",
  footageChoice: "prompt_only",
  footageMode: "asset_driven",
  selectedFootage: [],
  audience: "",
  platform: "tiktok",
  format: "visual_reveal",
  hook: "",
  bestVisual: "",
  bigIdea: "",
  payoff: "",
  accuracyNote: "",
  style: "fast-paced social ad",
  callToAction: "",
  provider: "openai",
  seedKind: "image",
  seedSize: "1024x1792",
  showCaptions: true,
  reviewGates: [],
};

// --- Flow + step contracts -------------------------------------------------

export interface StudioFlow {
  state: StudioState;
  /** Active step — drives the stepper highlight and which step renders. */
  step: StudioStep;
  /** Accumulated form state across steps. */
  brief: BriefDraft;
  /** Present once generation starts; null/undefined before. */
  run?: GenerationRun;
  /**
   * Latest reported stages for the active run. Not part of the minimal seam,
   * but exposed so the shell's generating checklist renders without a second
   * poll loop. PR 4's richer checklist consumes the same data.
   */
  stages: GenerationStage[];
  /** Result artifacts attached to the active run, including timeline outputs. */
  resultArtifacts: GenerationRunResultArtifact[];
  /** Project id of the in-flight run, for deep-link / polling. */
  projectId?: string;
  /** Project + cut data loaded only once review has a real timeline artifact. */
  reviewProject?: Project | null;
  reviewTimeline?: Timeline | null;
  reviewTimelineId?: string;
  reviewClips: Clip[];
  reviewSegmentNotes: Record<string, string>;
  reviewLoading: boolean;
  reviewError?: string;
  /** Set when startGeneration() failed; cleared on retry. */
  error?: string;
  goTo(step: StudioStep): void;
  back(): void;
  next(): void;
  update(patch: Partial<BriefDraft>): void;
  /** Create the project + start the run, then switch state to 'generating'. */
  startGeneration(): Promise<void>;
  /**
   * Approve the active run's review gate and resume. No-op when not gated.
   * Re-polls immediately so the generating view reflects the resumed run.
   */
  approveGate(note?: string): Promise<void>;
  /** Reject the active run's review gate (regenerate the gated stage). No-op when not gated. */
  rejectGate(note?: string): Promise<void>;
  /** Sends review feedback to the timeline revision endpoint when a timeline exists. */
  requestRevision(note: string): Promise<void>;
  /** Applies inline review edits to the loaded timeline so preview/export use the current cut. */
  updateReviewSegment(segmentId: string, patch: Partial<TimelineSegment>): void;
  /** Stores per-segment review notes next to the timeline editor. */
  updateReviewSegmentNote(segmentId: string, note: string): void;
  /** Complete the persisted draft after the cut is exported. */
  completeDraft(): Promise<void>;
}

/**
 * StepProps — every wizard step is `(props: StepProps) => JSX`. Steps only read
 * and patch the draft and move the cursor; they never read sibling state. This
 * is what lets wave-3 build each step independently.
 */
export interface StepProps {
  draft: BriefDraft;
  /** Active project created by generation; present for review/export steps. */
  projectId?: string;
  update(patch: Partial<BriefDraft>): void;
  next(): void;
  back(): void;
  completeDraft?(): Promise<void>;
}

// --- Polling cadence (mirrors RunProgressPage) -----------------------------

const POLL_INTERVAL_MS = 2000;
const REVIEW_POLL_INTERVAL_MS = 15000;

function isTerminal(status: GenerationRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

/**
 * The shell shows the terminal `review` state only on a SUCCEEDED run. A mid-run
 * review gate is NOT terminal — the run stays in `generating`, where the gate
 * card exposes approve/reject (see `approveGate`/`rejectGate`). Treating a gate
 * as "review-ready" stranded gated runs in a read-only panel with no way to
 * continue.
 */
function isReviewReady(run: GenerationRun): boolean {
  return run.status === "succeeded";
}

function isTimeline(value: unknown): value is Timeline {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { segments?: unknown };
  return Array.isArray(candidate.segments);
}

function timelineFromArtifactContent(content: unknown): Timeline | null {
  if (isTimeline(content)) return content;
  const nested = (content as { timeline?: unknown } | null)?.timeline;
  return isTimeline(nested) ? nested : null;
}

export interface UseStudioFlowOptions {
  /** Seed the draft (e.g. from `?goal=`/`?length=` query params). */
  initialBrief?: Partial<BriefDraft>;
  /** Active server-side draft id; when missing, the flow remains in-memory. */
  draftId?: string;
  /** Saved draft payload loaded by the Studio start screen. */
  initialPayload?: StudioDraftPayload | null;
}

/**
 * useStudioFlow — owns the wizard machine. Returns a `StudioFlow` the shell and
 * steps consume. Polls the active run (reusing RunProgressPage's cadence +
 * visibility handling) and flips to `review` at the first gate / on success.
 */
export function useStudioFlow(options: UseStudioFlowOptions = {}): StudioFlow {
  const restoredRun =
    options.initialPayload?.projectId && options.initialPayload?.runId
      ? {
          runId: options.initialPayload.runId,
          projectId: options.initialPayload.projectId,
          status: "queued" as GenerationRun["status"],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      : undefined;
  const [state, setState] = useState<StudioState>(
    restoredRun ? "generating" : "initial",
  );
  const [step, setStep] = useState<StudioStep>(
    restoredRun ? "generate" : options.initialPayload?.step ?? "brief",
  );
  const [brief, setBrief] = useState<BriefDraft>(() => ({
    ...EMPTY_BRIEF_DRAFT,
    ...options.initialPayload?.draft,
    ...options.initialBrief,
  }));
  const [run, setRun] = useState<GenerationRun | undefined>(restoredRun);
  const [stages, setStages] = useState<GenerationStage[]>([]);
  const [resultArtifacts, setResultArtifacts] = useState<GenerationRunResultArtifact[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>(
    options.initialPayload?.projectId,
  );
  const [reviewProject, setReviewProject] = useState<Project | null>(null);
  const [reviewTimeline, setReviewTimeline] = useState<Timeline | null>(null);
  const [reviewTimelineId, setReviewTimelineId] = useState<string | undefined>();
  const [reviewSegmentNotes, setReviewSegmentNotes] = useState<Record<string, string>>({});
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const draftId = options.draftId;
  const briefRef = useRef(brief);
  const stepRef = useRef(step);
  const projectIdRef = useRef(projectId);
  const runIdRef = useRef(run?.runId);

  useEffect(() => {
    briefRef.current = brief;
  }, [brief]);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);
  useEffect(() => {
    runIdRef.current = run?.runId;
  }, [run?.runId]);

  const persistDraft = useCallback(
    async (overrides: {
      draft?: BriefDraft;
      step?: StudioStep;
      projectId?: string;
      runId?: string;
    } = {}) => {
      if (!draftId) return;
      try {
        await saveDraft(
          draftId,
          overrides.draft ?? briefRef.current,
          overrides.step ?? stepRef.current,
          {
            projectId: overrides.projectId ?? projectIdRef.current,
            runId: overrides.runId ?? runIdRef.current,
          },
        );
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Could not save draft.");
      }
    },
    [draftId],
  );

  const update = useCallback((patch: Partial<BriefDraft>) => {
    setBrief((current) => ({ ...current, ...patch }));
  }, []);

  const goTo = useCallback((next: StudioStep) => {
    setStep(next);
    void persistDraft({ step: next });
  }, [persistDraft]);

  const next = useCallback(() => {
    setStep((current) => {
      const index = STUDIO_STEPS.indexOf(current);
      const nextStep = STUDIO_STEPS[Math.min(index + 1, STUDIO_STEPS.length - 1)];
      void persistDraft({ step: nextStep });
      return nextStep;
    });
  }, [persistDraft]);

  const back = useCallback(() => {
    setStep((current) => {
      const index = STUDIO_STEPS.indexOf(current);
      const nextStep = STUDIO_STEPS[Math.max(index - 1, 0)];
      void persistDraft({ step: nextStep });
      return nextStep;
    });
  }, [persistDraft]);

  useEffect(() => {
    if (!draftId) return;
    const timer = window.setTimeout(() => {
      void persistDraft({ draft: brief });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [brief, draftId, persistDraft]);

  const startGeneration = useCallback(async () => {
    setError(undefined);
    try {
      const { projectId: createdProjectId, runId } = await createAndStartRun(brief);
      setProjectId(createdProjectId);
      setReviewProject(null);
      setReviewTimeline(null);
      setReviewTimelineId(undefined);
      setReviewSegmentNotes({});
      setReviewError(undefined);
      setRun({
        runId,
        projectId: createdProjectId,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      setState("generating");
      setStep("generate");
      await persistDraft({
        draft: brief,
        step: "generate",
        projectId: createdProjectId,
        runId,
      });
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : "Could not start generation.",
      );
      throw startError;
    }
  }, [brief, persistDraft]);

  // Poll the active run while generating. Mirrors RunProgressPage: faster
  // cadence while running, slow while gated, pause when the tab is hidden, and
  // resume on visibility. Stays in `generating` while gated (the gate card
  // handles approve/reject) and flips to `review` only on terminal success.
  const pollRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (state !== "generating" || !projectId || !run) return;
    const runId = run.runId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    async function poll() {
      try {
        const data = await v1Api.getGenerationRun(projectId!, runId, controller.signal);
        if (cancelled) return;
        setRun(data.run);
        setStages(data.stages);
        setResultArtifacts(data.resultArtifacts ?? []);

        if (isReviewReady(data.run)) {
          setState("review");
          setStep("review");
          void persistDraft({
            step: "review",
            projectId: data.run.projectId,
            runId: data.run.runId,
          });
          return;
        }
        if (isTerminal(data.run.status)) return;
        if (document.visibilityState === "hidden") return;
        timer = setTimeout(
          poll,
          data.run.reviewGate ? REVIEW_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
        );
      } catch (pollError) {
        if (cancelled || controller.signal.aborted) return;
        setError(pollError instanceof Error ? pollError.message : String(pollError));
        timer = setTimeout(poll, POLL_INTERVAL_MS * 2);
      }
    }

    void poll();
    pollRef.current = () => {
      if (timer) clearTimeout(timer);
      void poll();
    };

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void poll();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      pollRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [state, projectId, run?.runId, persistDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveGate = useCallback(
    async (action: "approve" | "reject", note?: string) => {
      if (!projectId || !run?.runId || !run.reviewGate) return;
      setError(undefined);
      try {
        const data = await v1Api.updateGenerationRun(
          projectId,
          run.runId,
          action,
          note ? { note } : undefined,
        );
        setRun(data.run);
        setStages(data.stages);
        setResultArtifacts(data.resultArtifacts ?? []);
        // Re-poll immediately so the resumed run advances without waiting for
        // the slow gated cadence.
        pollRef.current?.();
      } catch (gateError) {
        setError(
          gateError instanceof Error ? gateError.message : "Could not update the review gate.",
        );
        throw gateError;
      }
    },
    [projectId, run?.runId, run?.reviewGate],
  );

  const approveGate = useCallback(
    (note?: string) => resolveGate("approve", note),
    [resolveGate],
  );
  const rejectGate = useCallback(
    (note?: string) => resolveGate("reject", note),
    [resolveGate],
  );

  useEffect(() => {
    if (state !== "review" || !projectId || !run?.runId) return;
    let cancelled = false;
    const controller = new AbortController();

    async function loadReviewCut() {
      setReviewLoading(true);
      setReviewError(undefined);
      try {
        const detail = await v1Api.getGenerationRun(projectId!, run!.runId, controller.signal);
        if (cancelled) return;
        setRun(detail.run);
        setStages(detail.stages);
        setResultArtifacts(detail.resultArtifacts ?? []);

        const timelineArtifact = (detail.resultArtifacts ?? []).find(
          (artifact) => artifact.kind === "timeline"
        );
        let loadedTimeline: Timeline | null = null;
        let loadedTimelineId: string | undefined;
        if (timelineArtifact) {
          const { artifact, timelineId } = await v1Api.getGenerationRunArtifact(
            projectId!,
            run!.runId,
            timelineArtifact.artifactId,
            controller.signal
          );
          if (cancelled) return;
          loadedTimeline = timelineFromArtifactContent(artifact.content);
          loadedTimelineId = timelineId;
        }

        const { project } = await v1Api.getStudioProjectById(projectId!, loadedTimeline);
        if (cancelled) return;
        setReviewProject(project);
        setReviewTimeline(project?.timeline ?? loadedTimeline);
        setReviewTimelineId(loadedTimelineId);
        setReviewSegmentNotes({});
      } catch (reviewLoadError) {
        if (cancelled || controller.signal.aborted) return;
        setReviewError(
          reviewLoadError instanceof Error
            ? reviewLoadError.message
            : "Could not load the review timeline."
        );
        setReviewProject(null);
        setReviewTimeline(null);
        setReviewTimelineId(undefined);
      } finally {
        if (!cancelled) setReviewLoading(false);
      }
    }

    void loadReviewCut();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [state, projectId, run?.runId]);

  const requestRevision = useCallback(
    async (note: string) => {
      const message = note.trim();
      if (!message || !projectId || !reviewTimelineId) return;
      setError(undefined);
      try {
        await v1Api.createTimelineRevision(projectId, reviewTimelineId, message);
      } catch (revisionError) {
        setError(
          revisionError instanceof Error
            ? revisionError.message
            : "Could not send timeline feedback."
        );
        throw revisionError;
      }
    },
    [projectId, reviewTimelineId],
  );

  const updateReviewSegment = useCallback(
    (segmentId: string, patch: Partial<TimelineSegment>) => {
      setReviewTimeline((current) => {
        if (!current) return current;
        return {
          ...current,
          segments: current.segments.map((segment) =>
            segment.id === segmentId ? { ...segment, ...patch } : segment
          ),
        };
      });
    },
    [],
  );

  const updateReviewSegmentNote = useCallback((segmentId: string, note: string) => {
    setReviewSegmentNotes((current) => ({ ...current, [segmentId]: note }));
  }, []);

  const completeDraft = useCallback(async () => {
    if (!draftId) return;
    await deleteDraft(draftId);
  }, [draftId]);

  return useMemo(
    () => ({
      state,
      step,
      brief,
      run,
      stages,
      resultArtifacts,
      projectId,
      reviewProject,
      reviewTimeline,
      reviewTimelineId,
      reviewClips: reviewProject?.clips ?? [],
      reviewSegmentNotes,
      reviewLoading,
      reviewError,
      error,
      goTo,
      back,
      next,
      update,
      startGeneration,
      approveGate,
      rejectGate,
      requestRevision,
      updateReviewSegment,
      updateReviewSegmentNote,
      completeDraft,
    }),
    [state, step, brief, run, stages, resultArtifacts, projectId, reviewProject, reviewTimeline, reviewTimelineId, reviewSegmentNotes, reviewLoading, reviewError, error, goTo, back, next, update, startGeneration, approveGate, rejectGate, requestRevision, updateReviewSegment, updateReviewSegmentNote, completeDraft],
  );
}
