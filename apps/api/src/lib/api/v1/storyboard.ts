import type {
  ProjectStoryboard,
  StoryboardItemStatus,
  StoryboardStatus,
} from "@popcorn/shared/v1/types";
import type { AuthContext } from "./auth";
import { ApiError, FieldError, validationError } from "./errors";
import {
  getProjectStoryboard,
  saveProjectStoryboard,
  type SaveStoryboardInput,
} from "./store";

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

const STORYBOARD_STATUSES: StoryboardStatus[] = [
  "draft",
  "generating",
  "ready",
  "reviewing",
  "approved",
  "archived",
];

const ITEM_STATUSES: StoryboardItemStatus[] = [
  "draft",
  "queued",
  "generating",
  "ready",
  "approved",
  "rejected",
  "failed",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown, path: string, fields: FieldError[]): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fields.push({ path, message: "Must be a non-negative number." });
    return null;
  }
  return value;
}

function parseStatus<T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly T[],
  path: string,
  fields: FieldError[]
): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  fields.push({ path, message: `Must be one of: ${allowed.join(", ")}.` });
  return fallback;
}

function parseSaveStoryboard(input: unknown): SaveStoryboardInput {
  if (!isObject(input)) {
    throw new ApiError("validation_failed", "The request body must be an object.");
  }
  const fields: FieldError[] = [];
  const scenesInput = Array.isArray(input.scenes) ? input.scenes : [];
  if (!Array.isArray(input.scenes)) {
    fields.push({ path: "scenes", message: "Must be an array." });
  }

  const sceneIds = new Set<string>();
  const beatIds = new Set<string>();
  const scenes = scenesInput.map((sceneValue, sceneIndex) => {
    const path = `scenes[${sceneIndex}]`;
    if (!isObject(sceneValue)) {
      fields.push({ path, message: "Must be an object." });
      return { id: "", title: null, beats: [] };
    }
    const id = optionalString(sceneValue.id);
    if (!id) fields.push({ path: `${path}.id`, message: "Required." });
    if (id && sceneIds.has(id)) fields.push({ path: `${path}.id`, message: "Must be unique." });
    if (id) sceneIds.add(id);

    const beatsInput = Array.isArray(sceneValue.beats) ? sceneValue.beats : [];
    if (!Array.isArray(sceneValue.beats)) {
      fields.push({ path: `${path}.beats`, message: "Must be an array." });
    }

    return {
      id: id ?? "",
      title: optionalString(sceneValue.title),
      summary: optionalString(sceneValue.summary),
      setting: optionalString(sceneValue.setting),
      mood: optionalString(sceneValue.mood),
      durationSec: optionalNumber(sceneValue.durationSec, `${path}.durationSec`, fields),
      status: parseStatus(
        sceneValue.status,
        "draft",
        ITEM_STATUSES,
        `${path}.status`,
        fields
      ),
      beats: beatsInput.map((beatValue, beatIndex) => {
        const beatPath = `${path}.beats[${beatIndex}]`;
        if (!isObject(beatValue)) {
          fields.push({ path: beatPath, message: "Must be an object." });
          return { id: "", intent: "" };
        }
        const beatId = optionalString(beatValue.id);
        const intent = optionalString(beatValue.intent);
        if (!beatId) fields.push({ path: `${beatPath}.id`, message: "Required." });
        if (beatId && beatIds.has(beatId)) {
          fields.push({ path: `${beatPath}.id`, message: "Must be unique." });
        }
        if (beatId) beatIds.add(beatId);
        if (!intent) fields.push({ path: `${beatPath}.intent`, message: "Required." });
        return {
          id: beatId ?? "",
          intent: intent ?? "",
          visualDescription: optionalString(beatValue.visualDescription),
          dialogueSummary: optionalString(beatValue.dialogueSummary),
          narration: optionalString(beatValue.narration),
          durationSec: optionalNumber(beatValue.durationSec, `${beatPath}.durationSec`, fields),
          status: parseStatus(
            beatValue.status,
            "draft",
            ITEM_STATUSES,
            `${beatPath}.status`,
            fields
          ),
        };
      }),
    };
  });

  const status = parseStatus(input.status, "draft", STORYBOARD_STATUSES, "status", fields);
  if (fields.length > 0) {
    throw validationError("The request body is invalid.", fields);
  }
  return {
    id: optionalString(input.id),
    status,
    scenes,
  };
}

export async function getStoryboard(input: {
  auth: AuthContext;
  projectId: string;
}): Promise<ApiResult> {
  const storyboard = await getProjectStoryboard(input.auth.workspaceId, input.projectId);
  return { status: 200, body: { storyboard } };
}

export async function putStoryboard(input: {
  auth: AuthContext;
  projectId: string;
  body: unknown;
}): Promise<{ status: number; body: { storyboard: ProjectStoryboard } }> {
  const storyboard = await saveProjectStoryboard(
    input.auth.workspaceId,
    input.projectId,
    parseSaveStoryboard(input.body)
  );
  return { status: 200, body: { storyboard } };
}
