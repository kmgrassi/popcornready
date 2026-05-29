// Request/response schemas and lightweight validators for the v1 agent API.
// Validation is intentionally hand-written (no schema library) to match the
// rest of the codebase. Validators throw ApiError("validation_failed").

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

export type AgentAssetSource =
  | { type: "remote_url"; url: string }
  | { type: "local_path"; path: string }
  | { type: "multipart_upload" }
  | { type: "generated"; generatedAssetId: string };

export interface AssetContext {
  summary?: string;
  recommendedRoles?: string[];
  moments?: { startSec: number; endSec: number; label?: string }[];
}

export interface RegisterAssetInput {
  source: AgentAssetSource;
  kind?: AssetKind;
  filename?: string;
  durationSec?: number;
  context?: AssetContext;
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

  let context: AssetContext | undefined;
  if (input.context !== undefined && input.context !== null) {
    if (!isPlainObject(input.context)) {
      fields.push({ path: "context", message: "Must be an object." });
    } else {
      context = {
        summary: optionalString(input.context.summary, "context.summary", fields),
        recommendedRoles: optionalStringArray(
          input.context.recommendedRoles,
          "context.recommendedRoles",
          fields
        ),
      };
    }
  }

  throwIfInvalid(fields);

  return {
    source: source as AgentAssetSource,
    kind,
    filename,
    durationSec,
    context,
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
