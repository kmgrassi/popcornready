// Standalone assemble + timeline-critique workers for the granular generation
// API (docs/scopes/granular-generation-api.md §3, P3 endpoint pair).
//
// These are THIN wrappers over the existing agent functions (`selectClips`,
// `critique`) and the v1 timeline store. They deliberately do NOT touch
// generation.ts (the engine-unification is a separate, later PR): assemble runs
// `selectClips` over a plan's beats + the project's selected/ready assets and
// persists the result as a first-class `VersionedTimeline`; critique runs
// `critique` over a stored timeline and returns scores + patches.
//
// Both are driven by the same v1 Job + GET-poll pattern that `generations.ts`
// uses, so a caller polls them exactly like every other stage.

import { critique as realCritique, selectClips as realSelectClips } from "../agent";
import {
  EDIT_GRAPH_COMPILER_VERSION,
  buildEditGraphFromTimeline,
  compileEditGraphToTimeline,
  ensureBeatIds,
  markGraphTimelineProjection,
} from "@popcorn/shared/edit-graph";
import { sanitizeTimeline } from "@popcorn/timeline/timeline";
import { randomUUID } from "crypto";
import { Clip, EditPlan, StoryContext } from "@popcorn/shared/types";
import { ApiError } from "./errors";
import { V1Store } from "./store";
import { assetToClip, briefToStoryContext } from "./generation/prepare";
import { CriticReport } from "@popcorn/shared/types";
import {
  CompositionPlan,
  SCHEMA,
  V1Asset,
  V1Project,
  VersionedTimeline,
} from "@popcorn/shared/v1/types";

// --- Injectable agent deps (deterministic, offline in tests) ---------------

export interface AssembleDeps {
  selectClips: typeof realSelectClips;
}
export interface CritiqueDeps {
  critique: typeof realCritique;
}

const defaultAssembleDeps: AssembleDeps = { selectClips: realSelectClips };
const defaultCritiqueDeps: CritiqueDeps = { critique: realCritique };

// --- Shared loaders --------------------------------------------------------

async function loadProjectScoped(
  store: V1Store,
  workspaceId: string,
  projectId: string
): Promise<V1Project> {
  const project = await store.getProject(projectId);
  if (!project || project.workspaceId !== workspaceId || project.status === "deleted") {
    throw new ApiError("not_found", `Project not found: ${projectId}`);
  }
  return project;
}

// Resolve a ready visual+audio clip set for the project. Explicit `assetIds`
// win; otherwise every ready asset in the project is used. Every id must exist,
// belong to the project, and be ready — a strict, actionable precondition.
async function resolveClips(
  store: V1Store,
  projectId: string,
  requestedAssetIds: string[] | undefined
): Promise<{ clips: Clip[]; assets: V1Asset[] }> {
  let assets: V1Asset[];
  if (requestedAssetIds && requestedAssetIds.length > 0) {
    assets = [];
    for (const id of requestedAssetIds) {
      const asset = await store.getAsset(id);
      if (!asset || asset.projectId !== projectId) {
        throw new ApiError("asset_invalid", `Asset not found in project: ${id}`, {
          fields: [{ path: "assetIds", message: `Unknown asset: ${id}` }],
        });
      }
      if (asset.status !== "ready") {
        throw new ApiError(
          "asset_not_ready",
          `Asset ${id} is not ready (status: ${asset.status}).`,
          { fields: [{ path: "assetIds", message: `Asset ${id} is ${asset.status}.` }] }
        );
      }
      assets.push(asset);
    }
  } else {
    assets = (await store.listAssets(projectId)).filter((a) => a.status === "ready");
  }

  if (assets.filter((a) => a.kind !== "audio").length === 0) {
    throw new ApiError(
      "validation_failed",
      "At least one ready video or image asset is required to assemble a timeline.",
      { fields: [{ path: "assetIds", message: "No ready visual assets are available." }] }
    );
  }
  return { clips: assets.map(assetToClip), assets };
}

// Reconstruct an EditPlan from a stored composition's plannedBeats, pulling
// length/style/aspect from the composition's brief version.
function planFromComposition(
  composition: CompositionPlan,
  brief: { targetLengthSec: number; aspectRatio: EditPlan["aspectRatio"]; style?: string }
): EditPlan {
  const plan: EditPlan = {
    targetLengthSec: brief.targetLengthSec,
    style: brief.style || "fast-paced social ad",
    aspectRatio: brief.aspectRatio,
    beats: composition.plannedBeats.map((b) => ({
      name: b.name,
      durationSec: b.durationSec,
      intent: b.intent,
    })),
  };
  ensureBeatIds(plan);
  return plan;
}

// Validate + normalize a caller-supplied raw plan object.
function parsePlan(value: unknown): EditPlan {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const beats = raw && Array.isArray(raw.beats) ? raw.beats : null;
  if (!raw || !beats || beats.length === 0) {
    throw new ApiError("validation_failed", "plan.beats must be a non-empty array.", {
      fields: [{ path: "plan.beats", message: "Provide at least one beat." }],
    });
  }
  const plan: EditPlan = {
    targetLengthSec: typeof raw.targetLengthSec === "number" ? raw.targetLengthSec : 15,
    style: typeof raw.style === "string" ? raw.style : "fast-paced social ad",
    aspectRatio: (typeof raw.aspectRatio === "string"
      ? raw.aspectRatio
      : "9:16") as EditPlan["aspectRatio"],
    beats: beats.map((b) => {
      const beat = b && typeof b === "object" ? (b as Record<string, unknown>) : {};
      return {
        ...(typeof beat.id === "string" ? { id: beat.id } : {}),
        name: typeof beat.name === "string" ? beat.name : "beat",
        durationSec: typeof beat.durationSec === "number" ? beat.durationSec : 3,
        intent: typeof beat.intent === "string" ? beat.intent : "",
      };
    }),
  };
  ensureBeatIds(plan);
  return plan;
}

// --- Assemble request resolution -------------------------------------------

export interface AssembleRequest {
  compositionId?: string;
  plan?: unknown;
  assetIds?: string[];
  goal?: string;
  showCaptions?: boolean;
}

export interface ResolvedAssembleInput {
  briefVersionId: string;
  compositionId?: string;
  plan: EditPlan;
  goal: string;
  clips: Clip[];
  assetIds: string[];
  // Job ids of the generated-asset jobs that produced the stitched assets, so
  // the assembled timeline keeps the dependency edge for audit / selective
  // regeneration (mirrors generation.ts provenance).
  generatedAssetJobIds: string[];
  storyContext: StoryContext | null;
  showCaptions?: boolean;
}

// Resolve + validate an assemble request into the inputs `selectClips` needs.
// Strict, typed preconditions: no plan AND no composition, or no ready assets,
// surface as structured ApiErrors so the agent can self-heal (NORTH_STAR §7).
export async function resolveAssemble(
  store: V1Store,
  workspaceId: string,
  projectId: string,
  body: AssembleRequest
): Promise<ResolvedAssembleInput> {
  await loadProjectScoped(store, workspaceId, projectId);

  const compositionId = body.compositionId ? String(body.compositionId) : undefined;
  const hasPlan = body.plan !== undefined && body.plan !== null;
  if (!compositionId && !hasPlan) {
    throw new ApiError(
      "validation_failed",
      "Provide a `plan` or a `compositionId` to assemble a timeline.",
      {
        fields: [
          { path: "plan", message: "Required unless compositionId is provided." },
          { path: "compositionId", message: "Required unless plan is provided." },
        ],
      }
    );
  }

  let plan: EditPlan;
  let briefVersionId: string;
  let storyContext: StoryContext | null = null;

  if (compositionId) {
    const composition = await store.getComposition(compositionId);
    if (!composition || composition.projectId !== projectId) {
      throw new ApiError("not_found", `Composition not found: ${compositionId}`);
    }
    if (composition.plannedBeats.length === 0) {
      throw new ApiError(
        "validation_failed",
        `Composition ${compositionId} has no planned beats to assemble.`,
        { fields: [{ path: "compositionId", message: "Composition has no beats." }] }
      );
    }
    briefVersionId = composition.briefVersionId;
    const brief = await store.getBriefVersion(briefVersionId);
    if (!brief || brief.projectId !== projectId) {
      throw new ApiError("not_found", `Brief version not found: ${briefVersionId}`);
    }
    storyContext = briefToStoryContext(brief.brief);
    plan = hasPlan
      ? parsePlan(body.plan)
      : planFromComposition(composition, brief.brief);
  } else {
    // Raw-plan assemble. A VersionedTimeline still requires a briefVersionId for
    // provenance; we synthesize a throwaway one from the plan so the timeline is
    // self-describing without forcing the caller to pre-create a brief.
    plan = parsePlan(body.plan);
    const synthesizedBrief = await store.saveBriefVersion({
      id: "",
      schemaVersion: SCHEMA.briefVersion,
      projectId,
      brief: {
        goal: typeof body.goal === "string" ? body.goal : "Assemble a timeline.",
        targetLengthSec: plan.targetLengthSec,
        aspectRatio: plan.aspectRatio,
        style: plan.style,
      },
      createdAt: new Date().toISOString(),
    });
    briefVersionId = synthesizedBrief.id;
    storyContext = briefToStoryContext(synthesizedBrief.brief);
  }

  const { clips, assets } = await resolveClips(store, projectId, body.assetIds);
  const assetIds = clips.map((c) => c.id);
  // Preserve provenance for assets that came from generated-asset jobs.
  const generatedAssetJobIds = [
    ...new Set(
      assets
        .map((asset) => asset.generatedAssetJobId)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  const goal =
    typeof body.goal === "string" && body.goal.trim()
      ? body.goal.trim()
      : plan.beats.map((b) => b.intent).filter(Boolean).join(" ") || "Assemble a timeline.";

  const showCaptions =
    body.showCaptions === undefined ? undefined : Boolean(body.showCaptions);

  return {
    briefVersionId,
    ...(compositionId ? { compositionId } : {}),
    plan,
    goal,
    clips,
    assetIds,
    generatedAssetJobIds,
    storyContext,
    ...(showCaptions === undefined ? {} : { showCaptions }),
  };
}

// --- Assemble worker -------------------------------------------------------

export interface AssembleResult {
  timelineId: string;
  editGraphId: string;
  segmentCount: number;
}

// Run `selectClips`, build the edit graph, and persist a VersionedTimeline.
// Mirrors generation.ts's persistence path but as a standalone single stage.
export async function runAssemble(args: {
  store: V1Store;
  jobId: string;
  input: ResolvedAssembleInput;
  projectId: string;
  deps?: Partial<AssembleDeps>;
}): Promise<AssembleResult> {
  const selectClips = args.deps?.selectClips ?? defaultAssembleDeps.selectClips;
  const { store, input, projectId, jobId } = args;

  const draft = sanitizeTimeline(
    await selectClips({
      plan: input.plan,
      clips: input.clips,
      goal: input.goal,
      storyContext: input.storyContext,
    }),
    input.clips
  );

  if (draft.segments.length === 0) {
    throw new ApiError(
      "timeline_invalid",
      "Assembled timeline has no valid segments — the selected assets did not cover any beat."
    );
  }

  const now = new Date().toISOString();
  const timelineForGraph =
    input.showCaptions === undefined
      ? draft
      : { ...draft, showCaptions: input.showCaptions };

  const editGraph = buildEditGraphFromTimeline({
    id: randomUUID(),
    projectId,
    briefVersionId: input.briefVersionId,
    ...(input.compositionId ? { compositionId: input.compositionId } : {}),
    jobId,
    goal: input.goal,
    storyContext: input.storyContext,
    plan: input.plan,
    clips: input.clips,
    timeline: timelineForGraph,
    createdAt: now,
  });
  const compiledTimeline = compileEditGraphToTimeline(editGraph);

  const savedGraph = await store.saveEditGraph(editGraph);
  const versioned: VersionedTimeline = {
    id: "",
    schemaVersion: SCHEMA.timeline,
    projectId,
    briefVersionId: input.briefVersionId,
    ...(input.compositionId ? { compositionId: input.compositionId } : {}),
    aspectRatio: compiledTimeline.aspectRatio,
    fps: compiledTimeline.fps,
    ...(input.showCaptions === undefined ? {} : { showCaptions: input.showCaptions }),
    segments: compiledTimeline.segments,
    provenance: {
      briefVersionId: input.briefVersionId,
      ...(input.compositionId ? { compositionId: input.compositionId } : {}),
      sourceAssetIds: input.assetIds,
      generatedAssetJobIds: input.generatedAssetJobIds,
      criticReport: null,
      appliedPatchCount: 0,
    },
    derivedFrom: {
      editGraphId: savedGraph.id,
      compilerVersion: EDIT_GRAPH_COMPILER_VERSION,
      compiledAt: now,
    },
    createdBy: { jobId },
    createdAt: now,
  };
  const savedTimeline = await store.saveTimeline(versioned);
  await store.saveEditGraph(
    markGraphTimelineProjection(savedGraph, savedTimeline.id, now)
  );

  return {
    timelineId: savedTimeline.id,
    editGraphId: savedGraph.id,
    segmentCount: compiledTimeline.segments.length,
  };
}

// --- Critique worker -------------------------------------------------------

export interface CritiqueResult {
  timelineId: string;
  report: CriticReport;
  patches: Awaited<ReturnType<typeof realCritique>>["patches"];
}

// Run `critique` over a stored timeline. Strict precondition: an unknown (or
// cross-project) timeline is a structured not_found, never a crash.
export async function runTimelineCritique(args: {
  store: V1Store;
  workspaceId: string;
  projectId: string;
  timelineId: string;
  deps?: Partial<CritiqueDeps>;
}): Promise<CritiqueResult> {
  const critique = args.deps?.critique ?? defaultCritiqueDeps.critique;
  const { store, workspaceId, projectId, timelineId } = args;

  await loadProjectScoped(store, workspaceId, projectId);

  const timeline = await store.getTimeline(timelineId);
  if (!timeline || timeline.projectId !== projectId) {
    throw new ApiError("not_found", `Timeline not found: ${timelineId}`, {
      fields: [{ path: "timelineId", message: "Unknown timeline for this project." }],
    });
  }

  // The critic needs the timeline + the clips its segments reference, plus a
  // light plan for context. Reconstruct a minimal EditPlan from the segments'
  // beats (the timeline is the source of truth here; we deliberately avoid
  // re-deriving from the edit-graph's distinct story schema).
  const beatsByName = new Map<string, { id?: string; name: string; intent: string }>();
  for (const seg of timeline.segments) {
    const name = seg.role || seg.beatId || "beat";
    if (!beatsByName.has(name)) {
      beatsByName.set(name, {
        ...(seg.beatId ? { id: seg.beatId } : {}),
        name,
        intent: seg.reason || "",
      });
    }
  }
  const plan: EditPlan = {
    targetLengthSec: 0,
    style: "",
    aspectRatio: timeline.aspectRatio,
    beats: [...beatsByName.values()].map((b) => ({ ...b, durationSec: 0 })),
  };

  const referencedClipIds = new Set(timeline.segments.map((s) => s.clipId));
  const assets = await store.listAssets(projectId);
  const clips: Clip[] = assets
    .filter((a) => referencedClipIds.has(a.id))
    .map(assetToClip);

  const result = await critique({
    plan,
    timeline: {
      aspectRatio: timeline.aspectRatio,
      fps: timeline.fps,
      ...(timeline.showCaptions === undefined ? {} : { showCaptions: timeline.showCaptions }),
      segments: timeline.segments,
    },
    clips,
    storyContext: null,
  });

  return { timelineId, report: result.report, patches: result.patches };
}
