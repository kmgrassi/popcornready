// Request/response schemas and lightweight validators for the v1 agent API.
// Validation is intentionally hand-written (no schema library) to match the
// rest of the codebase. Validators throw ApiError("validation_failed").

import type {
  AspectRatio as SharedAspectRatio,
  Beat,
  EditPlan,
  Scene,
} from "@popcorn/shared/types";
import { ApiError, FieldError, validationError } from "./errors";

export const SCHEMA_VERSIONS = {
  workspace: "workspace.v1",
  project: "project.v1",
  briefVersion: "briefVersion.v1",
  asset: "asset.v1",
} as const;

export type AspectRatio = "9:16" | "16:9" | "1:1";
const ASPECT_RATIOS: AspectRatio[] = ["9:16", "16:9", "1:1"];

export type Platform =
  | "youtube"
  | "tiktok"
  | "reels"
  | "facebook"
  | "vimeo"
  | "general";
const PLATFORMS: Platform[] = [
  "youtube",
  "tiktok",
  "reels",
  "facebook",
  "vimeo",
  "general",
];

export type VideoFormat =
  | "mystery_to_model"
  | "visual_reveal"
  | "challenge"
  | "misconception"
  | "animated_explainer"
  | "classroom_demo"
  | "aesthetic_montage";
const VIDEO_FORMATS: VideoFormat[] = [
  "mystery_to_model",
  "visual_reveal",
  "challenge",
  "misconception",
  "animated_explainer",
  "classroom_demo",
  "aesthetic_montage",
];

export type NarrationMode = "none" | "generate" | "provided_text" | "provided_asset";
const NARRATION_MODES: NarrationMode[] = [
  "none",
  "generate",
  "provided_text",
  "provided_asset",
];

export interface NarrationInput {
  mode: NarrationMode;
  script?: string;
  voiceId?: string;
  audioAssetId?: string;
}

export interface BriefConstraints {
  mustUseAssetIds?: string[];
  avoidAssetIds?: string[];
  requiredBeats?: string[];
  forbiddenClaims?: string[];
  brandVoice?: string;
  callToAction?: string;
}

export interface VideoBrief {
  goal: string;
  targetLengthSec: number;
  aspectRatio: AspectRatio;
  platform?: Platform;
  audience?: string;
  style?: string;
  format?: VideoFormat;
  narration?: NarrationInput;
  constraints?: BriefConstraints;
}

export type AssetKind = "video" | "image" | "audio";
const ASSET_KINDS: AssetKind[] = ["video", "image", "audio"];
export type AssetMediaType = AssetKind | "text" | "reference";
const ASSET_MEDIA_TYPES: AssetMediaType[] = [
  "video",
  "image",
  "audio",
  "text",
  "reference",
];
export type AssetOrigin = "uploaded" | "generated" | "imported" | "derived";
export type AssetUse =
  | "primary_footage"
  | "b_roll"
  | "character_reference"
  | "style_reference"
  | "location_reference"
  | "logo_or_brand"
  | "music"
  | "voiceover"
  | "dialogue"
  | "sound_effect"
  | "title_or_graphic";
const ASSET_USES: AssetUse[] = [
  "primary_footage",
  "b_roll",
  "character_reference",
  "style_reference",
  "location_reference",
  "logo_or_brand",
  "music",
  "voiceover",
  "dialogue",
  "sound_effect",
  "title_or_graphic",
];
export type KnowledgeConfidence = "low" | "medium" | "high";
const KNOWLEDGE_CONFIDENCES: KnowledgeConfidence[] = ["low", "medium", "high"];
export type KnownFactSource =
  | "user"
  | "agent"
  | "generation_prompt"
  | "metadata"
  | "transcript";
const KNOWN_FACT_SOURCES: KnownFactSource[] = [
  "user",
  "agent",
  "generation_prompt",
  "metadata",
  "transcript",
];
export type KnowledgeAction =
  | "ask_user"
  | "sample_video"
  | "analyze_image"
  | "transcribe_audio";
const KNOWLEDGE_ACTIONS: KnowledgeAction[] = [
  "ask_user",
  "sample_video",
  "analyze_image",
  "transcribe_audio",
];
export type AssetConstraintType =
  | "must_use"
  | "avoid"
  | "likeness_reference"
  | "style_reference"
  | "brand_required"
  | "audio_required"
  | "no_audio"
  | "do_not_crop"
  | "do_not_modify";
const ASSET_CONSTRAINT_TYPES: AssetConstraintType[] = [
  "must_use",
  "avoid",
  "likeness_reference",
  "style_reference",
  "brand_required",
  "audio_required",
  "no_audio",
  "do_not_crop",
  "do_not_modify",
];
export type AssetRelationshipType =
  | "derived_from"
  | "sampled_from"
  | "represents_character"
  | "represents_location"
  | "belongs_to_scene"
  | "audio_for"
  | "visual_for";
const ASSET_RELATIONSHIP_TYPES: AssetRelationshipType[] = [
  "derived_from",
  "sampled_from",
  "represents_character",
  "represents_location",
  "belongs_to_scene",
  "audio_for",
  "visual_for",
];

export type AgentAssetSource =
  | { type: "remote_url"; url: string }
  | { type: "local_path"; path: string }
  | { type: "multipart_upload" }
  | { type: "generated"; generatedAssetId: string };

export interface AssetContext {
  summary?: string;
  recommendedRoles?: string[];
  transcriptText?: string;
  moments?: { startSec: number; endSec: number; label?: string }[];
}

export interface UserAssetContext {
  title?: string;
  description?: string;
  people?: string[];
  characterNames?: string[];
  location?: string;
  event?: string;
  notableMoments?: string[];
  tags?: string[];
  transcriptHint?: string;
  audioNotes?: string;
  intendedUse?: AssetUse[];
  mustUse?: boolean;
  avoid?: boolean;
}

export type UserClipContext = UserAssetContext;

export interface UsableMoment {
  startSec: number;
  endSec: number;
  label: string;
  description: string;
  suggestedUse:
    | "hook"
    | "context"
    | "proof"
    | "emotion"
    | "transition"
    | "detail"
    | "b_roll"
    | "cta";
}
const USABLE_MOMENT_USES: UsableMoment["suggestedUse"][] = [
  "hook",
  "context",
  "proof",
  "emotion",
  "transition",
  "detail",
  "b_roll",
  "cta",
];

export interface AgentAssetContext {
  summary: string;
  mediaType: AssetMediaType;
  subjects: string[];
  actions?: string[];
  setting?: string;
  mood?: string;
  likelyUses: AssetUse[];
  cautions: string[];
  transcriptSummary?: string;
  confidence: KnowledgeConfidence;
  sampledAssetIds: string[];
  model: {
    provider: string;
    model?: string;
  };
}

export interface AgentClipContext extends AgentAssetContext {
  mediaType: "video";
  visualSubjects: string[];
  shotTypes: string[];
  usableMoments: UsableMoment[];
  sampledFrames: string[];
}

export interface KnownFact {
  field: string;
  value: string;
  confidence: KnowledgeConfidence;
  source: KnownFactSource;
}

export interface KnowledgeGap {
  field: string;
  question: string;
  canInferAutomatically: boolean;
  suggestedAction: KnowledgeAction;
}

export interface AssetConstraint {
  type: AssetConstraintType;
  reason?: string;
}

export interface AssetRelationship {
  type: AssetRelationshipType;
  targetAssetId: string;
  description?: string;
}

export interface AssetKnowledgeProvenance {
  createdAt: string;
  updatedAt: string;
  analysisVersion: string;
  model?: {
    provider: string;
    model?: string;
  };
  sourcePrompt?: string;
  sampledAssetIds: string[];
  transcriptAssetId?: string;
}

export interface AssetKnowledge {
  assetId: string;
  mediaType: AssetMediaType;
  origin: AssetOrigin;
  userContext?: UserAssetContext;
  agentContext?: AgentAssetContext | AgentClipContext;
  knowledgeScore: number;
  knowledgeSummary: string;
  knownFacts: KnownFact[];
  unknowns: KnowledgeGap[];
  likelyUses: AssetUse[];
  constraints: AssetConstraint[];
  relationships: AssetRelationship[];
  provenance: AssetKnowledgeProvenance;
}

export interface AssetKnowledgeSummary {
  assetId: string;
  mediaType: AssetMediaType;
  known: string[];
  unknown: KnowledgeGap[];
  likelyUses: AssetUse[];
  confidence: KnowledgeConfidence;
}

export interface LearningAction {
  assetId?: string;
  action: KnowledgeAction;
  reason: string;
}

export interface AssetInventoryReport {
  projectId: string;
  assets: AssetKnowledgeSummary[];
  globalKnowns: string[];
  globalUnknowns: KnowledgeGap[];
  recommendedLearningActions: LearningAction[];
  coverageEstimate: {
    video: "none" | "partial" | "complete";
    images: "none" | "partial" | "complete";
    audio: "none" | "partial" | "complete";
    characters: "none" | "partial" | "complete";
    brandsOrLogos: "none" | "partial" | "complete";
  };
}

export interface ClipUnderstanding {
  assetId: string;
  source: "upload" | "generated";
  userContext?: UserClipContext;
  agentContext?: AgentClipContext | AgentAssetContext;
  combinedSummary: string;
  timelineHints: {
    mustUse: boolean;
    avoid: boolean;
    preferredBeats: string[];
    bestStartSec?: number;
    bestEndSec?: number;
  };
  provenance: {
    userContextUpdatedAt?: string;
    analyzedAt?: string;
    analysisVersion: string;
    sampledFrameAssetIds: string[];
  };
}

export interface RegisterAssetInput {
  source: AgentAssetSource;
  kind?: AssetKind;
  filename?: string;
  durationSec?: number;
  context?: AssetContext;
  userContext?: UserAssetContext;
  agentContext?: AgentAssetContext | AgentClipContext;
}

export interface UpdateAssetContextInput {
  context?: AssetContext;
  userContext?: UserAssetContext | null;
  agentContext?: AgentAssetContext | AgentClipContext | null;
}

export interface AssetInventoryInput {
  assetIds?: string[];
  includeExistingContext: boolean;
}

export interface AnalyzeBatchOptions {
  sampleFrames: boolean;
  transcribeAudio: boolean;
  defaultVideoSamples: number;
  maxVideoSamples: number;
  storage: "local";
}

export interface AnalyzeBatchInput {
  assetIds: string[];
  userContext?: Record<string, unknown>;
  analysisOptions: AnalyzeBatchOptions;
}

export interface AnalyzeAssetInput {
  regenerate?: boolean;
  analysisOptions?: {
    sampleFrames?: boolean;
    transcribeAudio?: boolean;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  path: string,
  fields: FieldError[]
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    fields.push({ path, message: "Must be a non-empty string." });
    return undefined;
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  path: string,
  fields: FieldError[]
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    fields.push({ path, message: "Must be a string." });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalStringArray(
  value: unknown,
  path: string,
  fields: FieldError[]
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fields.push({ path, message: "Must be an array of strings." });
    return undefined;
  }
  return value as string[];
}

function optionalBoolean(
  value: unknown,
  path: string,
  fields: FieldError[]
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    fields.push({ path, message: "Must be a boolean." });
    return undefined;
  }
  return value;
}

function optionalInteger(
  value: unknown,
  path: string,
  fields: FieldError[],
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    fields.push({
      path,
      message: `Must be an integer between ${min} and ${max}.`,
    });
    return fallback;
  }
  return value;
}

function optionalEnumArray<T extends string>(
  value: unknown,
  allowed: T[],
  path: string,
  fields: FieldError[]
): T[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    fields.push({ path, message: `Must be an array of: ${allowed.join(", ")}.` });
    return undefined;
  }
  const parsed: T[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      fields.push({
        path: `${path}[${index}]`,
        message: `Must be one of: ${allowed.join(", ")}.`,
      });
      return;
    }
    parsed.push(item as T);
  });
  return parsed;
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: T[],
  path: string,
  fields: FieldError[]
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fields.push({ path, message: `Must be one of: ${allowed.join(", ")}.` });
    return undefined;
  }
  return value as T;
}

function throwIfInvalid(fields: FieldError[]): void {
  if (fields.length > 0) {
    throw validationError("The request body is invalid.", fields);
  }
}

export function parseBrief(input: unknown, pathPrefix = "brief"): VideoBrief {
  const fields: FieldError[] = [];
  if (!isPlainObject(input)) {
    throw validationError("The request body is invalid.", [
      { path: pathPrefix, message: "Must be an object." },
    ]);
  }

  const goal = requireString(input.goal, `${pathPrefix}.goal`, fields);

  let targetLengthSec: number | undefined;
  if (
    typeof input.targetLengthSec !== "number" ||
    !Number.isFinite(input.targetLengthSec) ||
    input.targetLengthSec < 1 ||
    input.targetLengthSec > 600
  ) {
    fields.push({
      path: `${pathPrefix}.targetLengthSec`,
      message: "Must be a number between 1 and 600.",
    });
  } else {
    targetLengthSec = input.targetLengthSec;
  }

  const aspectRatio = parseEnum(
    input.aspectRatio,
    ASPECT_RATIOS,
    `${pathPrefix}.aspectRatio`,
    fields
  );

  const platform = parseEnum(
    input.platform,
    PLATFORMS,
    `${pathPrefix}.platform`,
    fields
  );
  const format = parseEnum(
    input.format,
    VIDEO_FORMATS,
    `${pathPrefix}.format`,
    fields
  );

  let narration: NarrationInput | undefined;
  if (input.narration !== undefined && input.narration !== null) {
    if (!isPlainObject(input.narration)) {
      fields.push({ path: `${pathPrefix}.narration`, message: "Must be an object." });
    } else {
      const mode = parseEnum(
        input.narration.mode,
        NARRATION_MODES,
        `${pathPrefix}.narration.mode`,
        fields
      );
      if (mode) {
        narration = {
          mode,
          script: optionalString(
            input.narration.script,
            `${pathPrefix}.narration.script`,
            fields
          ),
          voiceId: optionalString(
            input.narration.voiceId,
            `${pathPrefix}.narration.voiceId`,
            fields
          ),
          audioAssetId: optionalString(
            input.narration.audioAssetId,
            `${pathPrefix}.narration.audioAssetId`,
            fields
          ),
        };
      }
    }
  }

  let constraints: BriefConstraints | undefined;
  if (input.constraints !== undefined && input.constraints !== null) {
    if (!isPlainObject(input.constraints)) {
      fields.push({ path: `${pathPrefix}.constraints`, message: "Must be an object." });
    } else {
      const c = input.constraints;
      constraints = {
        mustUseAssetIds: optionalStringArray(
          c.mustUseAssetIds,
          `${pathPrefix}.constraints.mustUseAssetIds`,
          fields
        ),
        avoidAssetIds: optionalStringArray(
          c.avoidAssetIds,
          `${pathPrefix}.constraints.avoidAssetIds`,
          fields
        ),
        requiredBeats: optionalStringArray(
          c.requiredBeats,
          `${pathPrefix}.constraints.requiredBeats`,
          fields
        ),
        forbiddenClaims: optionalStringArray(
          c.forbiddenClaims,
          `${pathPrefix}.constraints.forbiddenClaims`,
          fields
        ),
        brandVoice: optionalString(
          c.brandVoice,
          `${pathPrefix}.constraints.brandVoice`,
          fields
        ),
        callToAction: optionalString(
          c.callToAction,
          `${pathPrefix}.constraints.callToAction`,
          fields
        ),
      };
    }
  }

  // Validate optional text fields before throwing so malformed values surface
  // as validation_failed rather than being silently coerced to undefined.
  const audience = optionalString(input.audience, `${pathPrefix}.audience`, fields);
  const style = optionalString(input.style, `${pathPrefix}.style`, fields);

  throwIfInvalid(fields);

  return {
    goal: goal as string,
    targetLengthSec: targetLengthSec as number,
    aspectRatio: aspectRatio as AspectRatio,
    audience,
    style,
    platform,
    format,
    narration,
    constraints,
  };
}

export interface CreateProjectInput {
  name: string;
  brief?: VideoBrief;
}

export function parseCreateProject(input: unknown): CreateProjectInput {
  if (!isPlainObject(input)) {
    throw validationError("The request body is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const fields: FieldError[] = [];
  const name = requireString(input.name, "name", fields);
  throwIfInvalid(fields);

  const brief =
    input.brief !== undefined && input.brief !== null
      ? parseBrief(input.brief)
      : undefined;

  return { name: name as string, brief };
}

const KIND_BY_EXTENSION: Record<string, AssetKind> = {
  mp4: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
};

export function inferKindFromName(name: string): AssetKind | undefined {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext ? KIND_BY_EXTENSION[ext] : undefined;
}

function parseAssetSource(input: unknown, fields: FieldError[]): AgentAssetSource | undefined {
  if (!isPlainObject(input)) {
    fields.push({ path: "source", message: "Must be an object with a `type`." });
    return undefined;
  }
  const type = input.type;
  switch (type) {
    case "remote_url": {
      const url = requireString(input.url, "source.url", fields);
      if (!url) return undefined;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          fields.push({ path: "source.url", message: "Must be an http(s) URL." });
          return undefined;
        }
      } catch {
        fields.push({ path: "source.url", message: "Must be a valid URL." });
        return undefined;
      }
      return { type: "remote_url", url };
    }
    case "local_path": {
      const p = requireString(input.path, "source.path", fields);
      if (!p) return undefined;
      return { type: "local_path", path: p };
    }
    case "multipart_upload":
      return { type: "multipart_upload" };
    case "generated": {
      const generatedAssetId = requireString(
        input.generatedAssetId,
        "source.generatedAssetId",
        fields
      );
      if (!generatedAssetId) return undefined;
      return { type: "generated", generatedAssetId };
    }
    default:
      fields.push({
        path: "source.type",
        message:
          "Must be one of: remote_url, local_path, multipart_upload, generated.",
      });
      return undefined;
  }
}

function optionalMomentArray(
  value: unknown,
  path: string,
  fields: FieldError[]
): { startSec: number; endSec: number; label?: string }[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    fields.push({ path, message: "Must be an array of moments." });
    return undefined;
  }

  const moments: { startSec: number; endSec: number; label?: string }[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(item)) {
      fields.push({ path: itemPath, message: "Must be an object." });
      return;
    }
    if (
      typeof item.startSec !== "number" ||
      !Number.isFinite(item.startSec) ||
      item.startSec < 0
    ) {
      fields.push({ path: `${itemPath}.startSec`, message: "Must be a non-negative number." });
      return;
    }
    if (
      typeof item.endSec !== "number" ||
      !Number.isFinite(item.endSec) ||
      item.endSec < item.startSec
    ) {
      fields.push({
        path: `${itemPath}.endSec`,
        message: "Must be a number greater than or equal to startSec.",
      });
      return;
    }
    moments.push({
      startSec: item.startSec,
      endSec: item.endSec,
      label: optionalString(item.label, `${itemPath}.label`, fields),
    });
  });
  return moments;
}

function optionalUsableMomentArray(
  value: unknown,
  path: string,
  fields: FieldError[]
): UsableMoment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    fields.push({ path, message: "Must be an array of usable moments." });
    return undefined;
  }

  const moments: UsableMoment[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(item)) {
      fields.push({ path: itemPath, message: "Must be an object." });
      return;
    }
    if (
      typeof item.startSec !== "number" ||
      !Number.isFinite(item.startSec) ||
      item.startSec < 0
    ) {
      fields.push({
        path: `${itemPath}.startSec`,
        message: "Must be a non-negative number.",
      });
      return;
    }
    if (
      typeof item.endSec !== "number" ||
      !Number.isFinite(item.endSec) ||
      item.endSec < item.startSec
    ) {
      fields.push({
        path: `${itemPath}.endSec`,
        message: "Must be a number greater than or equal to startSec.",
      });
      return;
    }
    const label = requireString(item.label, `${itemPath}.label`, fields);
    const description = requireString(
      item.description,
      `${itemPath}.description`,
      fields
    );
    const suggestedUse = parseEnum(
      item.suggestedUse,
      USABLE_MOMENT_USES,
      `${itemPath}.suggestedUse`,
      fields
    );
    if (!label || !description || !suggestedUse) return;
    moments.push({
      startSec: item.startSec,
      endSec: item.endSec,
      label,
      description,
      suggestedUse,
    });
  });
  return moments;
}

function parseUserAssetContext(
  input: unknown,
  path: string,
  fields: FieldError[]
): UserAssetContext | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isPlainObject(input)) {
    fields.push({ path, message: "Must be an object." });
    return undefined;
  }
  return {
    title: optionalString(input.title, `${path}.title`, fields),
    description: optionalString(input.description, `${path}.description`, fields),
    people: optionalStringArray(input.people, `${path}.people`, fields),
    characterNames: optionalStringArray(
      input.characterNames,
      `${path}.characterNames`,
      fields
    ),
    location: optionalString(input.location, `${path}.location`, fields),
    event: optionalString(input.event, `${path}.event`, fields),
    notableMoments: optionalStringArray(
      input.notableMoments,
      `${path}.notableMoments`,
      fields
    ),
    tags: optionalStringArray(input.tags, `${path}.tags`, fields),
    transcriptHint: optionalString(input.transcriptHint, `${path}.transcriptHint`, fields),
    audioNotes: optionalString(input.audioNotes, `${path}.audioNotes`, fields),
    intendedUse: optionalEnumArray(
      input.intendedUse,
      ASSET_USES,
      `${path}.intendedUse`,
      fields
    ),
    mustUse: optionalBoolean(input.mustUse, `${path}.mustUse`, fields),
    avoid: optionalBoolean(input.avoid, `${path}.avoid`, fields),
  };
}

function parseAgentAssetContext(
  input: unknown,
  path: string,
  fields: FieldError[]
): AgentAssetContext | AgentClipContext | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isPlainObject(input)) {
    fields.push({ path, message: "Must be an object." });
    return undefined;
  }

  const summary = requireString(input.summary, `${path}.summary`, fields);
  const mediaType = parseEnum(
    input.mediaType,
    ASSET_MEDIA_TYPES,
    `${path}.mediaType`,
    fields
  );
  const confidence = parseEnum(
    input.confidence,
    KNOWLEDGE_CONFIDENCES,
    `${path}.confidence`,
    fields
  );
  const subjects = optionalStringArray(input.subjects, `${path}.subjects`, fields) ?? [];
  const likelyUses =
    optionalEnumArray(input.likelyUses, ASSET_USES, `${path}.likelyUses`, fields) ?? [];
  const cautions = optionalStringArray(input.cautions, `${path}.cautions`, fields) ?? [];
  const sampledAssetIds =
    optionalStringArray(input.sampledAssetIds, `${path}.sampledAssetIds`, fields) ?? [];

  let model: AgentAssetContext["model"] | undefined;
  if (!isPlainObject(input.model)) {
    fields.push({ path: `${path}.model`, message: "Must be an object." });
  } else {
    const provider = requireString(input.model.provider, `${path}.model.provider`, fields);
    model = {
      provider: provider as string,
      model: optionalString(input.model.model, `${path}.model.model`, fields),
    };
  }

  const base: AgentAssetContext = {
    summary: summary as string,
    mediaType: mediaType as AssetMediaType,
    subjects,
    actions: optionalStringArray(input.actions, `${path}.actions`, fields),
    setting: optionalString(input.setting, `${path}.setting`, fields),
    mood: optionalString(input.mood, `${path}.mood`, fields),
    likelyUses,
    cautions,
    transcriptSummary: optionalString(
      input.transcriptSummary,
      `${path}.transcriptSummary`,
      fields
    ),
    confidence: confidence as KnowledgeConfidence,
    sampledAssetIds,
    model: model as AgentAssetContext["model"],
  };

  if (mediaType !== "video") return base;

  return {
    ...base,
    mediaType: "video",
    visualSubjects:
      optionalStringArray(input.visualSubjects, `${path}.visualSubjects`, fields) ?? [],
    shotTypes: optionalStringArray(input.shotTypes, `${path}.shotTypes`, fields) ?? [],
    usableMoments:
      optionalUsableMomentArray(input.usableMoments, `${path}.usableMoments`, fields) ?? [],
    sampledFrames: optionalStringArray(input.sampledFrames, `${path}.sampledFrames`, fields) ?? [],
  };
}

function parseAssetContext(
  input: unknown,
  path: string,
  fields: FieldError[]
): AssetContext | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isPlainObject(input)) {
    fields.push({ path, message: "Must be an object." });
    return undefined;
  }
  const context: AssetContext = {};
  const summary = optionalString(input.summary, `${path}.summary`, fields);
  const recommendedRoles = optionalStringArray(
    input.recommendedRoles,
    `${path}.recommendedRoles`,
    fields
  );
  const transcriptText = optionalString(input.transcriptText, `${path}.transcriptText`, fields);
  const moments = optionalMomentArray(input.moments, `${path}.moments`, fields);
  if (summary !== undefined) context.summary = summary;
  if (recommendedRoles !== undefined) context.recommendedRoles = recommendedRoles;
  if (transcriptText !== undefined) context.transcriptText = transcriptText;
  if (moments !== undefined) context.moments = moments;
  return context;
}

export function parseRegisterAsset(input: unknown): RegisterAssetInput {
  if (!isPlainObject(input)) {
    throw validationError("The request body is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const fields: FieldError[] = [];
  const source = parseAssetSource(input.source, fields);
  const kind = parseEnum(input.kind, ASSET_KINDS, "kind", fields);
  const filename = optionalString(input.filename, "filename", fields);

  let durationSec: number | undefined;
  if (input.durationSec !== undefined && input.durationSec !== null) {
    if (typeof input.durationSec !== "number" || !Number.isFinite(input.durationSec) || input.durationSec < 0) {
      fields.push({ path: "durationSec", message: "Must be a non-negative number." });
    } else {
      durationSec = input.durationSec;
    }
  }

  const context = parseAssetContext(input.context, "context", fields);
  const userContext = parseUserAssetContext(input.userContext, "userContext", fields);
  const agentContext = parseAgentAssetContext(input.agentContext, "agentContext", fields);

  throwIfInvalid(fields);

  return {
    source: source as AgentAssetSource,
    kind,
    filename,
    durationSec,
    context,
    userContext,
    agentContext,
  };
}

export function parseUpdateAssetContext(input: unknown): UpdateAssetContextInput {
  if (!isPlainObject(input)) {
    throw validationError("The request body is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const fields: FieldError[] = [];
  const context = parseAssetContext(input.context, "context", fields);
  const userContext =
    input.userContext === null
      ? null
      : parseUserAssetContext(input.userContext, "userContext", fields);
  const agentContext =
    input.agentContext === null
      ? null
      : parseAgentAssetContext(input.agentContext, "agentContext", fields);

  throwIfInvalid(fields);

  return { context, userContext, agentContext };
}

export function parseAssetInventory(input: unknown): AssetInventoryInput {
  if (input === undefined || input === null) {
    return { includeExistingContext: true };
  }
  if (!isPlainObject(input)) {
    throw validationError("The request body is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const fields: FieldError[] = [];
  const assetIds = optionalStringArray(input.assetIds, "assetIds", fields);
  const includeExistingContext =
    input.includeExistingContext === undefined
      ? true
      : optionalBoolean(input.includeExistingContext, "includeExistingContext", fields);
  throwIfInvalid(fields);
  return { assetIds, includeExistingContext: includeExistingContext ?? true };
}

export function parseAnalyzeBatch(input: unknown): AnalyzeBatchInput {
  if (!isPlainObject(input)) {
    throw validationError("The request body is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const fields: FieldError[] = [];

  let assetIds: string[] = [];
  if (!Array.isArray(input.assetIds) || input.assetIds.length === 0) {
    fields.push({ path: "assetIds", message: "Must be a non-empty array of asset IDs." });
  } else if (input.assetIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    fields.push({ path: "assetIds", message: "Must contain only non-empty strings." });
  } else {
    assetIds = [...new Set(input.assetIds.map((id) => id.trim()))];
  }

  let userContext: Record<string, unknown> | undefined;
  if (input.userContext !== undefined && input.userContext !== null) {
    if (!isPlainObject(input.userContext)) {
      fields.push({ path: "userContext", message: "Must be an object." });
    } else {
      userContext = input.userContext;
    }
  }

  const rawOptions = isPlainObject(input.analysisOptions)
    ? input.analysisOptions
    : {};
  if (
    input.analysisOptions !== undefined &&
    input.analysisOptions !== null &&
    !isPlainObject(input.analysisOptions)
  ) {
    fields.push({ path: "analysisOptions", message: "Must be an object." });
  }

  const defaultVideoSamples = optionalInteger(
    rawOptions.defaultVideoSamples,
    "analysisOptions.defaultVideoSamples",
    fields,
    5,
    1,
    10
  );
  const maxVideoSamples = optionalInteger(
    rawOptions.maxVideoSamples,
    "analysisOptions.maxVideoSamples",
    fields,
    10,
    1,
    10
  );
  const storage = parseEnum(
    rawOptions.storage,
    ["local"],
    "analysisOptions.storage",
    fields
  );
  const sampleFrames = optionalBoolean(
    rawOptions.sampleFrames,
    "analysisOptions.sampleFrames",
    fields
  );
  const transcribeAudio = optionalBoolean(
    rawOptions.transcribeAudio,
    "analysisOptions.transcribeAudio",
    fields
  );
  if (transcribeAudio) {
    fields.push({
      path: "analysisOptions.transcribeAudio",
      message: "Audio transcription is not implemented for asset analysis yet.",
    });
  }

  throwIfInvalid(fields);

  return {
    assetIds,
    userContext,
    analysisOptions: {
      sampleFrames: sampleFrames ?? true,
      transcribeAudio: transcribeAudio ?? false,
      defaultVideoSamples,
      maxVideoSamples: Math.max(defaultVideoSamples, maxVideoSamples),
      storage: storage ?? "local",
    },
  };
}

export function parseAnalyzeAsset(input: unknown): AnalyzeAssetInput {
  const body = input === undefined || input === null ? {} : input;
  if (!isPlainObject(body)) {
    throw validationError("The request body is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const fields: FieldError[] = [];
  let analysisOptions: AnalyzeAssetInput["analysisOptions"];
  if (body.analysisOptions !== undefined && body.analysisOptions !== null) {
    if (!isPlainObject(body.analysisOptions)) {
      fields.push({ path: "analysisOptions", message: "Must be an object." });
    } else {
      analysisOptions = {
        sampleFrames: optionalBoolean(
          body.analysisOptions.sampleFrames,
          "analysisOptions.sampleFrames",
          fields
        ),
        transcribeAudio: optionalBoolean(
          body.analysisOptions.transcribeAudio,
          "analysisOptions.transcribeAudio",
          fields
        ),
      };
    }
  }
  const regenerate = optionalBoolean(body.regenerate, "regenerate", fields);
  throwIfInvalid(fields);
  return {
    ...(regenerate === undefined ? {} : { regenerate }),
    ...(analysisOptions ? { analysisOptions } : {}),
  };
}

export function parsePagination(searchParams: URLSearchParams): {
  limit: number;
  cursor: string | null;
} {
  const rawLimit = searchParams.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new ApiError("validation_failed", "limit must be an integer between 1 and 100.", {
        fields: [{ path: "limit", message: "Must be an integer between 1 and 100." }],
      });
    }
    limit = parsed;
  }
  return { limit, cursor: searchParams.get("cursor") };
}

export function parseDiscoverAssetsQuery(searchParams: URLSearchParams): {
  limit: number;
  cursor: string | null;
  kind?: AssetKind;
} {
  const { limit, cursor } = parsePagination(searchParams);
  const rawKind = searchParams.get("kind");
  if (rawKind !== null && !ASSET_KINDS.includes(rawKind as AssetKind)) {
    throw new ApiError("validation_failed", "kind must be one of: video, image, audio.", {
      fields: [{ path: "kind", message: "Must be one of: video, image, audio." }],
    });
  }
  return { limit, cursor, ...(rawKind ? { kind: rawKind as AssetKind } : {}) };
}

export function parseDiscoverSearchQuery(searchParams: URLSearchParams): {
  q: string;
  limit: number;
  cursor: string | null;
  kind?: AssetKind;
} {
  const q = searchParams.get("q")?.trim();
  if (!q) {
    throw new ApiError("validation_failed", "q is required.", {
      fields: [{ path: "q", message: "Must be a non-empty search query." }],
    });
  }
  if (q.length > 200) {
    throw new ApiError("validation_failed", "q must be 200 characters or fewer.", {
      fields: [{ path: "q", message: "Must be 200 characters or fewer." }],
    });
  }
  return { q, ...parseDiscoverAssetsQuery(searchParams) };
}

// --- Storyboard plan editing (PR6) -----------------------------------------
//
// Validates an EditPlan posted from the storyboard editor. The plan is Scenes ->
// Beats; every scene and beat MUST carry a stable `id` so downstream
// assets/provenance keep referencing the same nodes across edits. We reject a
// plan with missing/duplicate ids rather than silently re-mint them.

function requireNumber(
  value: unknown,
  path: string,
  fields: FieldError[],
  opts: { min?: number; max?: number } = {}
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fields.push({ path, message: "Must be a finite number." });
    return undefined;
  }
  if (opts.min !== undefined && value < opts.min) {
    fields.push({ path, message: `Must be >= ${opts.min}.` });
    return undefined;
  }
  if (opts.max !== undefined && value > opts.max) {
    fields.push({ path, message: `Must be <= ${opts.max}.` });
    return undefined;
  }
  return value;
}

function parseBeat(
  input: unknown,
  path: string,
  fields: FieldError[],
  seenIds: Set<string>
): Beat | undefined {
  if (!isPlainObject(input)) {
    fields.push({ path, message: "Must be an object." });
    return undefined;
  }
  const id = requireString(input.id, `${path}.id`, fields);
  const name = requireString(input.name, `${path}.name`, fields);
  const intent = requireString(input.intent, `${path}.intent`, fields);
  const durationSec = requireNumber(input.durationSec, `${path}.durationSec`, fields, {
    min: 0,
    max: 600,
  });
  if (id) {
    if (seenIds.has(id)) {
      fields.push({ path: `${path}.id`, message: `Duplicate id "${id}".` });
    } else {
      seenIds.add(id);
    }
  }
  if (!id || !name || !intent || durationSec === undefined) return undefined;
  return { id, name, intent, durationSec };
}

function parseScene(
  input: unknown,
  path: string,
  fields: FieldError[],
  sceneIds: Set<string>,
  beatIds: Set<string>
): Scene | undefined {
  if (!isPlainObject(input)) {
    fields.push({ path, message: "Must be an object." });
    return undefined;
  }
  const id = requireString(input.id, `${path}.id`, fields);
  const name = requireString(input.name, `${path}.name`, fields);
  const setting = optionalString(input.setting, `${path}.setting`, fields);
  const mood = optionalString(input.mood, `${path}.mood`, fields);
  const anchorAssetId = optionalString(input.anchorAssetId, `${path}.anchorAssetId`, fields);
  const characterIds = optionalStringArray(input.characterIds, `${path}.characterIds`, fields);

  if (id) {
    if (sceneIds.has(id)) {
      fields.push({ path: `${path}.id`, message: `Duplicate scene id "${id}".` });
    } else {
      sceneIds.add(id);
    }
  }

  if (!Array.isArray(input.beats)) {
    fields.push({ path: `${path}.beats`, message: "Must be an array." });
    return undefined;
  }
  const beats: Beat[] = [];
  input.beats.forEach((b, i) => {
    const beat = parseBeat(b, `${path}.beats[${i}]`, fields, beatIds);
    if (beat) beats.push(beat);
  });

  if (!id || !name) return undefined;
  return {
    id,
    name,
    ...(setting ? { setting } : {}),
    ...(mood ? { mood } : {}),
    ...(characterIds ? { characterIds } : {}),
    ...(anchorAssetId ? { anchorAssetId } : {}),
    beats,
  };
}

export function parseUpdateProjectPlan(input: unknown): EditPlan {
  if (!isPlainObject(input)) {
    throw validationError("The request body is invalid.", [
      { path: "", message: "Must be an object." },
    ]);
  }
  const fields: FieldError[] = [];
  const targetLengthSec = requireNumber(input.targetLengthSec, "targetLengthSec", fields, {
    min: 1,
    max: 3600,
  });
  const style = requireString(input.style, "style", fields);
  const aspectRatio = parseEnum<SharedAspectRatio>(
    input.aspectRatio,
    ASPECT_RATIOS as SharedAspectRatio[],
    "aspectRatio",
    fields
  );

  if (!Array.isArray(input.scenes)) {
    fields.push({ path: "scenes", message: "Must be an array of scenes." });
    throwIfInvalid(fields);
  }

  const sceneIds = new Set<string>();
  const beatIds = new Set<string>();
  const scenes: Scene[] = [];
  (input.scenes as unknown[]).forEach((s, i) => {
    const scene = parseScene(s, `scenes[${i}]`, fields, sceneIds, beatIds);
    if (scene) scenes.push(scene);
  });

  throwIfInvalid(fields);

  return {
    targetLengthSec: targetLengthSec as number,
    style: style as string,
    aspectRatio: aspectRatio as SharedAspectRatio,
    scenes,
  };
}
