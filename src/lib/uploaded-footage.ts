import { Clip, UploadedFootageEditMode } from "./types";

export interface UploadedFootageEditRequest {
  mode: UploadedFootageEditMode;
  assetIds: string[];
  allowGeneratedGapFill: boolean;
}

export function parseUploadedFootageEditRequest(
  body: Record<string, unknown>
): UploadedFootageEditRequest {
  const rawMode = String(body.mode || "asset_driven");
  if (rawMode !== "asset_driven" && rawMode !== "hybrid") {
    throw new Error(`Unsupported uploaded-footage mode: ${rawMode}`);
  }

  const assetIds = Array.isArray(body.assetIds)
    ? body.assetIds
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0)
    : [];

  return {
    mode: rawMode,
    assetIds: [...new Set(assetIds)],
    allowGeneratedGapFill:
      body.allowGeneratedGapFill === true ||
      body.allowGeneratedGapFill === "true" ||
      rawMode === "hybrid",
  };
}

export function resolveUploadedFootageClips(
  clips: Clip[],
  request: UploadedFootageEditRequest
): Clip[] {
  const visualClips = clips.filter((clip) => (clip.kind || "video") !== "audio");
  const selectedIds =
    request.assetIds.length > 0
      ? new Set(request.assetIds)
      : new Set(
          visualClips
            .filter((clip) => clip.source !== "generated")
            .map((clip) => clip.id)
        );

  const selected = visualClips.filter((clip) => selectedIds.has(clip.id));
  const missingIds = [...selectedIds].filter(
    (id) => !visualClips.some((clip) => clip.id === id)
  );
  if (missingIds.length) {
    throw new Error(`Selected asset not found: ${missingIds.join(", ")}`);
  }
  if (selected.length === 0) {
    throw new Error("Select at least one uploaded visual asset before editing.");
  }
  return selected;
}

