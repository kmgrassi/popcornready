// useStudioFlow — the Studio wizard's state machine and shared contract.
//
// This is the seam wave-3 step PRs (Brief, Footage, Story, Generate, Review,
// Export) build against. Steps never reach into siblings: they read/patch the
// accumulated `BriefDraft` and call `next()`/`back()`. The hook owns the
// `initial → generating → review` machine, the active step, run creation, and
// the polling that drives the generation checklist + review handoff.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AspectRatio,
  GateableGenerationStageType,
  GenerationRun,
  GenerationStage,
} from "@popcorn/shared/v1/types";
import type { StoryContext } from "@popcorn/shared/types";
import { v1Api } from "../../lib/api-client";
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
  /** Project id of the in-flight run, for deep-link / polling. */
  projectId?: string;
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
}

/**
 * StepProps — every wizard step is `(props: StepProps) => JSX`. Steps only read
 * and patch the draft and move the cursor; they never read sibling state. This
 * is what lets wave-3 build each step independently.
 */
export interface StepProps {
  draft: BriefDraft;
  update(patch: Partial<BriefDraft>): void;
  next(): void;
  back(): void;
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

export interface UseStudioFlowOptions {
  /** Seed the draft (e.g. from `?goal=`/`?length=` query params). */
  initialBrief?: Partial<BriefDraft>;
}

/**
 * useStudioFlow — owns the wizard machine. Returns a `StudioFlow` the shell and
 * steps consume. Polls the active run (reusing RunProgressPage's cadence +
 * visibility handling) and flips to `review` at the first gate / on success.
 */
export function useStudioFlow(options: UseStudioFlowOptions = {}): StudioFlow {
  const [state, setState] = useState<StudioState>("initial");
  const [step, setStep] = useState<StudioStep>("brief");
  const [brief, setBrief] = useState<BriefDraft>(() => ({
    ...EMPTY_BRIEF_DRAFT,
    ...options.initialBrief,
  }));
  const [run, setRun] = useState<GenerationRun | undefined>();
  const [stages, setStages] = useState<GenerationStage[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const update = useCallback((patch: Partial<BriefDraft>) => {
    setBrief((current) => ({ ...current, ...patch }));
  }, []);

  const goTo = useCallback((next: StudioStep) => {
    setStep(next);
  }, []);

  const next = useCallback(() => {
    setStep((current) => {
      const index = STUDIO_STEPS.indexOf(current);
      return STUDIO_STEPS[Math.min(index + 1, STUDIO_STEPS.length - 1)];
    });
  }, []);

  const back = useCallback(() => {
    setStep((current) => {
      const index = STUDIO_STEPS.indexOf(current);
      return STUDIO_STEPS[Math.max(index - 1, 0)];
    });
  }, []);

  const startGeneration = useCallback(async () => {
    setError(undefined);
    try {
      const { projectId: createdProjectId, runId } = await createAndStartRun(brief);
      setProjectId(createdProjectId);
      setRun({
        runId,
        projectId: createdProjectId,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      setState("generating");
      setStep("generate");
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : "Could not start generation.",
      );
      throw startError;
    }
  }, [brief]);

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

        if (isReviewReady(data.run)) {
          setState("review");
          setStep("review");
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
  }, [state, projectId, run?.runId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return useMemo(
    () => ({
      state,
      step,
      brief,
      run,
      stages,
      projectId,
      error,
      goTo,
      back,
      next,
      update,
      startGeneration,
      approveGate,
      rejectGate,
    }),
    [state, step, brief, run, stages, projectId, error, goTo, back, next, update, startGeneration, approveGate, rejectGate],
  );
}
