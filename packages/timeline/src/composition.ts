// Pure composition planning. Turns proposed beats (from the planner agent or a
// test fixture) plus the project's available assets into a CompositionPlan and
// the queued asset-generation jobs needed before a timeline can be built.
// Executing those jobs is a later step; this module only plans and validates.

import {
  AssetGenerationJob,
  AssetGenerationKind,
  Clip,
  CompositionAssetStrategy,
  CompositionMode,
  CompositionNarrationStrategy,
  CompositionPlan,
  CompositionPlannedBeat,
  CompositionStatus,
} from "@popcorn/shared/types";

const COMPOSITION_MODES: CompositionMode[] = [
  "asset_driven",
  "prompt_only",
  "hybrid",
];

export function parseCompositionMode(value: unknown): CompositionMode {
  const mode = String(value ?? "").trim();
  if ((COMPOSITION_MODES as string[]).includes(mode)) {
    return mode as CompositionMode;
  }
  throw new Error(
    `Unsupported composition mode: "${mode}". Expected one of ${COMPOSITION_MODES.join(
      ", "
    )}.`
  );
}

export interface ProviderDefaults {
  image: string;
  video: string;
  audio: string;
}

const FALLBACK_PROVIDERS: ProviderDefaults = {
  image: "openai",
  video: "gemini",
  audio: "elevenlabs",
};

export interface ProviderPolicyInput {
  allowedProviders?: {
    image?: string[];
    video?: string[];
    audio?: string[];
  };
}

export function resolveProviderDefaults(
  policy?: ProviderPolicyInput
): ProviderDefaults {
  const pick = (kind: keyof ProviderDefaults): string => {
    const allowed = policy?.allowedProviders?.[kind];
    return Array.isArray(allowed) && allowed.length > 0
      ? String(allowed[0])
      : FALLBACK_PROVIDERS[kind];
  };
  return { image: pick("image"), video: pick("video"), audio: pick("audio") };
}

export interface AssetPolicyInput {
  useProvidedAssets?: boolean;
  generateMissingAssets?: boolean;
  maxGeneratedImages?: number;
  maxGeneratedVideos?: number;
  maxGeneratedAudio?: number;
}

export interface ResolvedAssetPolicy {
  useProvidedAssets: boolean;
  generateMissingAssets: boolean;
  maxGeneratedImages: number;
  maxGeneratedVideos: number;
  maxGeneratedAudio: number;
}

const DEFAULT_ASSET_POLICY: ResolvedAssetPolicy = {
  useProvidedAssets: true,
  generateMissingAssets: true,
  maxGeneratedImages: 10,
  maxGeneratedVideos: 3,
  maxGeneratedAudio: 1,
};

function numOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveAssetPolicy(
  input?: AssetPolicyInput
): ResolvedAssetPolicy {
  return {
    useProvidedAssets:
      input?.useProvidedAssets ?? DEFAULT_ASSET_POLICY.useProvidedAssets,
    generateMissingAssets:
      input?.generateMissingAssets ??
      DEFAULT_ASSET_POLICY.generateMissingAssets,
    maxGeneratedImages: numOr(
      input?.maxGeneratedImages,
      DEFAULT_ASSET_POLICY.maxGeneratedImages
    ),
    maxGeneratedVideos: numOr(
      input?.maxGeneratedVideos,
      DEFAULT_ASSET_POLICY.maxGeneratedVideos
    ),
    maxGeneratedAudio: numOr(
      input?.maxGeneratedAudio,
      DEFAULT_ASSET_POLICY.maxGeneratedAudio
    ),
  };
}

// A beat as proposed by the planner agent (or a test). The pure builder
// reconciles these proposals against the composition mode and the assets that
// actually exist before committing to a final strategy.
export interface PlannedBeatProposal {
  name: string;
  intent: string;
  durationSec: number;
  assetStrategy?: CompositionAssetStrategy;
  requiredAssetIds?: string[];
  generationKind?: "image" | "video";
  generationPrompt?: string;
  generationProvider?: string;
}

export interface NarrationProposal {
  mode: "none" | "provided" | "generate";
  script?: string;
  audioAssetId?: string;
  provider?: string;
}

export interface BuildCompositionInput {
  projectId: string;
  mode: CompositionMode;
  beats: PlannedBeatProposal[];
  availableAssets: Clip[];
  narration?: NarrationProposal;
  providers: ProviderDefaults;
  assetPolicy: ResolvedAssetPolicy;
  briefVersionId?: string;
  idempotencyKey?: string;
  newId?: (prefix: string) => string;
  now?: () => Date;
}

export interface BuildCompositionResult {
  composition: CompositionPlan;
  jobs: AssetGenerationJob[];
}

function defaultNewId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

export function buildCompositionPlan(
  input: BuildCompositionInput
): BuildCompositionResult {
  const newId = input.newId ?? defaultNewId;
  const timestamp = (input.now ? input.now() : new Date()).toISOString();

  if (input.beats.length === 0) {
    throw new Error("Composition planning produced no beats.");
  }

  const assetById = new Map(input.availableAssets.map((a) => [a.id, a]));
  const compositionId = newId("comp");
  const jobs: AssetGenerationJob[] = [];
  const plannedBeats: CompositionPlannedBeat[] = [];
  const counts: Record<AssetGenerationKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
  };
  let needsAssets = false;

  const createJob = (
    kind: AssetGenerationKind,
    provider: string,
    prompt: string,
    beatName: string
  ): AssetGenerationJob => {
    counts[kind] += 1;
    const job: AssetGenerationJob = {
      id: newId("job"),
      compositionId,
      projectId: input.projectId,
      beatName,
      kind,
      provider,
      prompt: prompt.trim() || beatName,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    jobs.push(job);
    return job;
  };

  for (const beat of input.beats) {
    const name = String(beat.name || "").trim();
    if (!name) throw new Error("A planned beat is missing a name.");
    const intent = String(beat.intent || "").trim();
    const durationSec = Number(beat.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error(`Beat "${name}" has an invalid durationSec.`);
    }

    // Dangling references are always a bug; ignore them only in prompt-only
    // mode, where provided assets are intentionally not used.
    const requested = (beat.requiredAssetIds || []).map(String).filter(Boolean);
    if (input.mode !== "prompt_only") {
      for (const id of requested) {
        if (!assetById.has(id)) {
          throw new Error(`Beat "${name}" references unknown asset: ${id}.`);
        }
      }
    }
    const validExistingIds =
      input.mode === "prompt_only"
        ? []
        : requested.filter((id) => assetById.has(id));

    const canUseExisting =
      input.mode !== "prompt_only" &&
      input.assetPolicy.useProvidedAssets &&
      validExistingIds.length > 0;

    if (canUseExisting) {
      plannedBeats.push({
        name,
        intent,
        durationSec,
        assetStrategy: "use_existing",
        requiredAssetIds: validExistingIds,
      });
      continue;
    }

    // The beat is "missing": no usable existing asset.
    if (input.mode === "asset_driven") {
      throw new Error(
        `Composition mode asset_driven requires beat "${name}" to reference at least one existing asset.`
      );
    }

    // Honor an explicit generationKind; otherwise derive the kind from the
    // proposed assetStrategy so a "generate_video" beat is not silently
    // downgraded to an image job when generationKind is omitted.
    const wantsVideo =
      beat.generationKind === "video" ||
      (beat.generationKind === undefined &&
        beat.assetStrategy === "generate_video");
    const genStrategy: CompositionAssetStrategy = wantsVideo
      ? "generate_video"
      : "generate_image";

    if (!input.assetPolicy.generateMissingAssets) {
      // Record the gap so the caller knows what to supply, but generate nothing.
      needsAssets = true;
      plannedBeats.push({
        name,
        intent,
        durationSec,
        assetStrategy: genStrategy,
        generatedAssetJobIds: [],
      });
      continue;
    }

    const kind: AssetGenerationKind =
      genStrategy === "generate_video" ? "video" : "image";
    const provider =
      (beat.generationProvider && String(beat.generationProvider)) ||
      (kind === "video" ? input.providers.video : input.providers.image);
    const job = createJob(
      kind,
      provider,
      beat.generationPrompt || intent || name,
      name
    );
    plannedBeats.push({
      name,
      intent,
      durationSec,
      assetStrategy: genStrategy,
      generatedAssetJobIds: [job.id],
    });
  }

  const narrationStrategy = planNarration({
    narration: input.narration,
    assetById,
    assetPolicy: input.assetPolicy,
    providers: input.providers,
    createJob,
    onGap: () => {
      needsAssets = true;
    },
  });

  enforceCaps(counts, input.assetPolicy);

  const status: CompositionStatus = needsAssets
    ? "needs_assets"
    : "ready_for_timeline";

  const composition: CompositionPlan = {
    id: compositionId,
    projectId: input.projectId,
    briefVersionId: input.briefVersionId,
    idempotencyKey: input.idempotencyKey,
    mode: input.mode,
    plannedBeats,
    narrationStrategy,
    generatedAssetJobIds: jobs.map((j) => j.id),
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return { composition, jobs };
}

// Deterministic check that the planner actually honored the caller's explicit
// asset constraints. Validated against the built plan (the assets it will
// really use), not just the planner prompt. Skipped in prompt_only mode, which
// intentionally ignores provided assets.
export function assertCompositionConstraints(
  composition: CompositionPlan,
  constraints: { mustUseAssetIds?: string[]; avoidAssetIds?: string[] }
): void {
  if (composition.mode === "prompt_only") return;

  const used = new Set<string>();
  for (const beat of composition.plannedBeats) {
    for (const id of beat.requiredAssetIds || []) used.add(id);
  }

  for (const id of constraints.mustUseAssetIds || []) {
    if (!used.has(id)) {
      throw new Error(`Composition omits required asset: ${id}.`);
    }
  }
  for (const id of constraints.avoidAssetIds || []) {
    if (used.has(id)) {
      throw new Error(`Composition uses an avoided asset: ${id}.`);
    }
  }
}

function planNarration(args: {
  narration?: NarrationProposal;
  assetById: Map<string, Clip>;
  assetPolicy: ResolvedAssetPolicy;
  providers: ProviderDefaults;
  createJob: (
    kind: AssetGenerationKind,
    provider: string,
    prompt: string,
    beatName: string
  ) => AssetGenerationJob;
  onGap: () => void;
}): CompositionNarrationStrategy | undefined {
  const narration = args.narration;
  if (!narration || narration.mode === "none") {
    return narration ? { mode: "none" } : undefined;
  }

  if (narration.mode === "provided") {
    if (narration.audioAssetId) {
      const asset = args.assetById.get(narration.audioAssetId);
      if (!asset) {
        throw new Error(
          `Narration references unknown audio asset: ${narration.audioAssetId}.`
        );
      }
      if (asset.kind && asset.kind !== "audio") {
        throw new Error(
          `Narration asset ${narration.audioAssetId} is not an audio asset.`
        );
      }
    }
    return {
      mode: "provided",
      script: narration.script,
      audioAssetId: narration.audioAssetId,
    };
  }

  // narration.mode === "generate"
  if (!args.assetPolicy.generateMissingAssets) {
    args.onGap();
    return { mode: "generate", script: narration.script };
  }
  args.createJob(
    "audio",
    narration.provider || args.providers.audio,
    narration.script || "Narration for the video.",
    "narration"
  );
  return { mode: "generate", script: narration.script };
}

function enforceCaps(
  counts: Record<AssetGenerationKind, number>,
  policy: ResolvedAssetPolicy
): void {
  if (counts.image > policy.maxGeneratedImages) {
    throw new Error(
      `Composition needs ${counts.image} generated images but maxGeneratedImages is ${policy.maxGeneratedImages}.`
    );
  }
  if (counts.video > policy.maxGeneratedVideos) {
    throw new Error(
      `Composition needs ${counts.video} generated videos but maxGeneratedVideos is ${policy.maxGeneratedVideos}.`
    );
  }
  if (counts.audio > policy.maxGeneratedAudio) {
    throw new Error(
      `Composition needs ${counts.audio} generated audio assets but maxGeneratedAudio is ${policy.maxGeneratedAudio}.`
    );
  }
}
