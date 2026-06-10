import type {
  DashboardActiveRunSummary,
  DashboardRecentOutput,
  DashboardSummary,
} from "@popcorn/shared/v1/dashboard";
import type { RunReviewGate } from "@popcorn/shared/v1/types";
import { isRunActive } from "./v1/generation-runs/status";

export interface DraftSummary {
  draftId: string;
  goalExcerpt: string;
  step: number;
  totalSteps: number;
  updatedAt: string;
}

type GatedRun = DashboardActiveRunSummary & {
  reviewGate?: RunReviewGate | null;
};

export type NextAction =
  | {
      type: "review_gate";
      run: GatedRun;
      title: string;
      body: string;
      ctaLabel: string;
      to: string;
    }
  | {
      type: "watch_run";
      run: DashboardActiveRunSummary;
      title: string;
      body: string;
      ctaLabel: string;
      to: string;
    }
  | {
      type: "review_cut";
      output: DashboardRecentOutput;
      title: string;
      body: string;
      ctaLabel: string;
      to: string;
    }
  | {
      type: "resume_draft";
      draft: DraftSummary;
      title: string;
      body: string;
      ctaLabel: string;
      to: string;
    }
  | {
      type: "start";
      title: string;
      body: string;
      ctaLabel: string;
      to: string;
    }
  | {
      type: "new";
      title: string;
      body: string;
      ctaLabel: string;
      to: string;
    };

export function deriveNextAction(
  pulse: DashboardSummary | null | undefined,
  drafts: readonly DraftSummary[] = [],
): NextAction {
  const gatedRun = pulse?.activeRuns.find(
    (run): run is GatedRun => Boolean((run as GatedRun).reviewGate),
  );
  if (gatedRun) {
    return {
      type: "review_gate",
      run: gatedRun,
      title: "Your cut is waiting for review",
      body: `${gatedRun.projectName} is paused at ${formatStage(gatedRun.currentStageType)} until you approve the next step.`,
      ctaLabel: "Review gate",
      to: runPath(gatedRun),
    };
  }

  const activeRun = pulse?.activeRuns.find((run) => isRunActive(run.status));
  if (activeRun) {
    return {
      type: "watch_run",
      run: activeRun,
      title: "Watch this generation",
      body: `${activeRun.projectName} is ${formatStage(activeRun.currentStageType).toLowerCase()} at ${activeRun.progressPercent ?? 0}% complete.`,
      ctaLabel: "Open progress",
      to: runPath(activeRun),
    };
  }

  const recentOutput = pulse?.recentOutputs[0];
  if (recentOutput) {
    return {
      type: "review_cut",
      output: recentOutput,
      title: "Review your rough cut",
      body: `${recentOutput.projectName} finished recently. Check the exported cut and decide what changes next.`,
      ctaLabel: "Review output",
      to: outputPath(recentOutput),
    };
  }

  const draft = drafts[0];
  if (draft) {
    return {
      type: "resume_draft",
      draft,
      title: `Continue your draft - ${draft.goalExcerpt}`,
      body: `Resume step ${draft.step} of ${draft.totalSteps}.`,
      ctaLabel: "Continue draft",
      to: `/studio?draft=${encodeURIComponent(draft.draftId)}`,
    };
  }

  if (!pulse || pulse.counts.projects === 0) {
    return {
      type: "start",
      title: "Create your first AI rough cut",
      body: "Start with a brief. Popcorn Ready will guide the plan, generation, review, and export one step at a time.",
      ctaLabel: "Start a video",
      to: "/studio",
    };
  }

  return {
    type: "new",
    title: "Start the next rough cut",
    body: "No workspace item needs attention right now. Create a new video when you are ready.",
    ctaLabel: "New video",
    to: "/studio",
  };
}

function runPath(run: Pick<DashboardActiveRunSummary, "projectId" | "runId">) {
  return `/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.runId)}`;
}

function outputPath(output: DashboardRecentOutput) {
  const params = new URLSearchParams({ projectId: output.projectId });
  return `/outputs?${params.toString()}`;
}

function formatStage(stage: DashboardActiveRunSummary["currentStageType"]) {
  if (!stage) return "Preparing";
  return stage
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
