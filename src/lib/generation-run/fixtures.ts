// Fixture data for the progress-view shell.
//
// The progress UI shell (PR #6 in docs/scopes/generation-progress-ui.md) is
// landing before the run persistence and polling endpoints exist, so the route
// renders against these in-memory fixtures. Once PRs #1-#5 land they can be
// dropped and replaced with a real polling client.
//
// `buildDemoRun(runId, now)` returns a snapshot whose timestamps are positioned
// relative to `now` so running fixtures look freshly-started rather than days
// stale.

import {
  GENERATION_STAGE_LABELS,
  GENERATION_STAGE_ORDER,
  GenerationRun,
  GenerationStage,
  GenerationStageItem,
  GenerationStageType,
} from "@/lib/v1/types";

export type DemoRunId =
  | "demo-running"
  | "demo-queued"
  | "demo-succeeded"
  | "demo-failed"
  | "demo-canceled";

export const DEMO_RUN_IDS: DemoRunId[] = [
  "demo-running",
  "demo-queued",
  "demo-succeeded",
  "demo-failed",
  "demo-canceled",
];

const ALL_STAGES: GenerationStageType[] = [
  "brief_intake",
  "creative_plan",
  "asset_generation",
  "audio_generation",
  "timeline_assembly",
  "quality_review",
  "export",
  "ready",
];

interface BuiltRun {
  run: GenerationRun;
  stages: GenerationStage[];
  items: GenerationStageItem[];
}

export interface DemoRunSnapshot extends BuiltRun {
  runId: DemoRunId;
}

function iso(date: Date): string {
  return date.toISOString();
}

function offset(now: Date, deltaMs: number): Date {
  return new Date(now.getTime() + deltaMs);
}

function stage(
  runId: string,
  type: GenerationStageType,
  overrides: Omit<Partial<GenerationStage>, "createdAt" | "updatedAt"> = {},
  now: Date = new Date(),
): GenerationStage {
  const nowIso = iso(now);
  const stageRecord: GenerationStage = {
    stageId: `${runId}-${type}`,
    runId,
    type,
    label: GENERATION_STAGE_LABELS[type],
    order: GENERATION_STAGE_ORDER[type],
    status: "queued",
    jobIds: [],
    artifactIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };

  return stageRecord;
}

function item(
  data: Omit<GenerationStageItem, "createdAt" | "updatedAt">,
  now: Date = new Date(),
): GenerationStageItem {
  const nowIso = iso(now);
  return {
    ...data,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function buildRunning(now: Date): BuiltRun {
  const runId = "demo-running";
  const startedAt = offset(now, -47_000); // ~47s ago
  const stages: GenerationStage[] = [
    stage(runId, "brief_intake", {
      status: "succeeded",
      startedAt: iso(offset(now, -47_000)),
      completedAt: iso(offset(now, -45_500)),
      progressPercent: 100,
      message: "Saved your brief.",
    }),
    stage(runId, "creative_plan", {
      status: "succeeded",
      startedAt: iso(offset(now, -45_400)),
      completedAt: iso(offset(now, -32_000)),
      progressPercent: 100,
      message: "Planned 6 beats for a 30-second cut.",
    }),
    stage(runId, "asset_generation", {
      status: "running",
      startedAt: iso(offset(now, -31_500)),
      progressPercent: 38,
      message: "Generating visual 3 of 8 (Gemini Veo).",
    }),
    stage(runId, "audio_generation", { status: "queued" }),
    stage(runId, "timeline_assembly", { status: "queued" }),
    stage(runId, "quality_review", { status: "queued" }),
    stage(runId, "export", { status: "queued" }),
  ];

  const items: GenerationStageItem[] = [
    item({
      itemId: `${runId}-asset-1`,
      stageId: `${runId}-asset_generation`,
      kind: "image",
      label: "Hook — pouring kettle",
      status: "succeeded",
      provider: "openai",
      assetId: "asset-1",
    }),
    item({
      itemId: `${runId}-asset-2`,
      stageId: `${runId}-asset_generation`,
      kind: "video",
      label: "Beat 2 — steam rises",
      status: "succeeded",
      provider: "gemini",
      assetId: "asset-2",
    }),
    item({
      itemId: `${runId}-asset-3`,
      stageId: `${runId}-asset_generation`,
      kind: "video",
      label: "Beat 3 — close-up sip",
      status: "running",
      provider: "gemini",
      progressPercent: 38,
      promptPreview: "Cinematic close-up of a person sipping coffee at sunrise.",
    }),
  ];

  return {
    run: {
      runId,
      projectId: "demo-project",
      briefVersionId: "brief-1",
      status: "running",
      currentStageType: "asset_generation",
      progressPercent: 32,
      message: "Generating visual 3 of 8.",
      createdAt: iso(offset(now, -48_000)),
      updatedAt: iso(now),
      startedAt: iso(startedAt),
    },
    stages,
    items,
  };
}

function buildQueued(now: Date): BuiltRun {
  const runId = "demo-queued";
  const stages = ALL_STAGES.slice(0, 7).map((type) => stage(runId, type));
  return {
    run: {
      runId,
      projectId: "demo-project",
      briefVersionId: "brief-q",
      status: "queued",
      message: "Waiting for a worker.",
      createdAt: iso(offset(now, -2_500)),
      updatedAt: iso(now),
    },
    stages,
    items: [],
  };
}

function buildSucceeded(now: Date): BuiltRun {
  const runId = "demo-succeeded";
  const startedAt = offset(now, -8 * 60_000 - 14_000);
  const completedAt = offset(now, -45_000);
  const stages: GenerationStage[] = [
    stage(runId, "brief_intake", { status: "succeeded", progressPercent: 100 }),
    stage(runId, "creative_plan", { status: "succeeded", progressPercent: 100 }),
    stage(runId, "asset_generation", {
      status: "succeeded",
      progressPercent: 100,
      message: "8 visuals ready.",
    }),
    stage(runId, "audio_generation", {
      status: "succeeded",
      progressPercent: 100,
      message: "Narration aligned.",
    }),
    stage(runId, "timeline_assembly", {
      status: "succeeded",
      progressPercent: 100,
    }),
    stage(runId, "quality_review", {
      status: "succeeded",
      progressPercent: 100,
      message: "No issues found.",
    }),
    stage(runId, "export", {
      status: "succeeded",
      progressPercent: 100,
      message: "Rendered final MP4.",
    }),
    stage(runId, "ready", {
      status: "succeeded",
      message: "Your video is ready.",
    }),
  ];
  return {
    run: {
      runId,
      projectId: "demo-project",
      briefVersionId: "brief-s",
      status: "succeeded",
      currentStageType: "ready",
      progressPercent: 100,
      message: "Your video is ready.",
      createdAt: iso(offset(startedAt, -1_000)),
      updatedAt: iso(completedAt),
      startedAt: iso(startedAt),
      completedAt: iso(completedAt),
    },
    stages,
    items: [],
  };
}

function buildFailed(now: Date): BuiltRun {
  const runId = "demo-failed";
  const startedAt = offset(now, -2 * 60_000 - 18_000);
  const failedAt = offset(now, -22_000);
  const error = {
    code: "provider_timeout",
    message: "Visual generation timed out after 90s. Try again.",
    retryable: true,
  } as const;
  const stages: GenerationStage[] = [
    stage(runId, "brief_intake", { status: "succeeded", progressPercent: 100 }),
    stage(runId, "creative_plan", {
      status: "succeeded",
      progressPercent: 100,
      message: "Planned 5 beats for a 20-second cut.",
    }),
    stage(runId, "asset_generation", {
      status: "failed",
      progressPercent: 60,
      message: "Provider timed out on visual 4 of 5.",
      completedAt: iso(failedAt),
      error,
    }),
    stage(runId, "audio_generation", { status: "queued" }),
    stage(runId, "timeline_assembly", { status: "queued" }),
    stage(runId, "quality_review", { status: "queued" }),
    stage(runId, "export", { status: "queued" }),
  ];
  return {
    run: {
      runId,
      projectId: "demo-project",
      briefVersionId: "brief-f",
      status: "failed",
      currentStageType: "asset_generation",
      progressPercent: 36,
      message: "Visual generation failed.",
      createdAt: iso(offset(startedAt, -1_000)),
      updatedAt: iso(failedAt),
      startedAt: iso(startedAt),
      completedAt: iso(failedAt),
      error,
    },
    stages,
    items: [],
  };
}

function buildCanceled(now: Date): BuiltRun {
  const runId = "demo-canceled";
  const startedAt = offset(now, -55_000);
  const canceledAt = offset(now, -8_000);
  const stages: GenerationStage[] = [
    stage(runId, "brief_intake", { status: "succeeded", progressPercent: 100 }),
    stage(runId, "creative_plan", {
      status: "succeeded",
      progressPercent: 100,
    }),
    stage(runId, "asset_generation", {
      status: "canceled",
      progressPercent: 18,
      message: "Canceled before all visuals finished.",
      completedAt: iso(canceledAt),
    }),
    stage(runId, "audio_generation", { status: "canceled" }),
    stage(runId, "timeline_assembly", { status: "canceled" }),
    stage(runId, "quality_review", { status: "canceled" }),
    stage(runId, "export", { status: "canceled" }),
  ];
  return {
    run: {
      runId,
      projectId: "demo-project",
      briefVersionId: "brief-c",
      status: "canceled",
      currentStageType: "asset_generation",
      progressPercent: 18,
      message: "You canceled this run.",
      createdAt: iso(offset(startedAt, -1_000)),
      updatedAt: iso(canceledAt),
      startedAt: iso(startedAt),
      completedAt: iso(canceledAt),
    },
    stages,
    items: [],
  };
}

const BUILDERS: Record<DemoRunId, (now: Date) => BuiltRun> = {
  "demo-running": buildRunning,
  "demo-queued": buildQueued,
  "demo-succeeded": buildSucceeded,
  "demo-failed": buildFailed,
  "demo-canceled": buildCanceled,
};

export function isDemoRunId(value: string): value is DemoRunId {
  return (DEMO_RUN_IDS as string[]).includes(value);
}

export function buildDemoRun(runId: DemoRunId, now: Date): DemoRunSnapshot {
  return { runId, ...BUILDERS[runId](now) };
}
