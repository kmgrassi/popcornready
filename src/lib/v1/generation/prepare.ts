import { mergeStoryContext } from "../../story-context";
import { Clip, StoryContext } from "../../types";
import { ApiError } from "../errors";
import { V1Store } from "../store";
import {
  CompositionPlan,
  CompositionMode,
  GenerationJobInput,
  GenerationRequest,
  V1Asset,
  VideoBriefInput,
} from "../types";

// --- Mapping helpers -------------------------------------------------------

export function briefToStoryContext(brief: VideoBriefInput): StoryContext {
  const partial: StoryContext = {};
  if (brief.audience) partial.audience = brief.audience;
  if (brief.platform) partial.platform = brief.platform;
  if (brief.format) partial.format = brief.format;
  if (brief.constraints?.callToAction) {
    partial.callToAction = brief.constraints.callToAction;
  }
  return mergeStoryContext(partial);
}

// The agent layer reasons over MVP Clips; map a v1 asset onto that shape.
export function assetToClip(asset: V1Asset): Clip {
  return {
    id: asset.id,
    filename: asset.filename,
    url: asset.url,
    kind: asset.kind,
    durationSec: asset.durationSec,
    description: asset.description || "",
    source: asset.source === "generated" ? "generated" : "upload",
  };
}

// --- Validation / resolution ----------------------------------------------

const COMPOSITION_MODES = new Set<CompositionMode>([
  "asset_driven",
  "prompt_only",
  "hybrid",
]);

function parseMode(value: unknown): CompositionMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !COMPOSITION_MODES.has(value as CompositionMode)) {
    throw new ApiError(
      "validation_failed",
      "mode must be asset_driven, prompt_only, or hybrid.",
      {
        fields: [
          {
            path: "mode",
            message: "Must be one of: asset_driven, prompt_only, hybrid.",
          },
        ],
      }
    );
  }
  return value as CompositionMode;
}

function parseAllowGeneratedGapFill(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError("validation_failed", "allowGeneratedGapFill must be a boolean.", {
      fields: [{ path: "allowGeneratedGapFill", message: "Must be true or false." }],
    });
  }
  return value;
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function generatedGapBeatNames(composition: CompositionPlan): string[] {
  return composition.plannedBeats
    .filter(
      (beat) =>
        beat.assetStrategy === "generate_image" ||
        beat.assetStrategy === "generate_video"
    )
    .map((beat) => beat.name);
}

function requireExplicitHybridGapFillChoice(
  composition: CompositionPlan,
  allowGeneratedGapFill: boolean | undefined
): void {
  const missingBeats = generatedGapBeatNames(composition);
  if (composition.mode !== "hybrid" || missingBeats.length === 0) return;
  if (allowGeneratedGapFill !== undefined) return;

  throw new ApiError(
    "validation_failed",
    "Hybrid gap fill requires an explicit allowGeneratedGapFill choice.",
    {
      fields: [
        {
          path: "allowGeneratedGapFill",
          message:
            "Set true to include generated gap-fill assets, or false to proceed uploaded-only.",
        },
      ],
      missingBeats,
    }
  );
}

export async function prepareGeneration(
  store: V1Store,
  projectId: string,
  body: GenerationRequest
): Promise<GenerationJobInput> {
  const project = await store.getProject(projectId);
  if (!project || project.status === "deleted") {
    throw new ApiError("not_found", `Project not found: ${projectId}`);
  }

  const briefVersionId = String(body.briefVersionId || "").trim();
  if (!briefVersionId) {
    throw new ApiError("brief_missing", "briefVersionId is required.", {
      fields: [{ path: "briefVersionId", message: "Required." }],
    });
  }
  const brief = await store.getBriefVersion(briefVersionId);
  if (!brief || brief.projectId !== projectId) {
    throw new ApiError("not_found", `Brief version not found: ${briefVersionId}`);
  }

  const variantCount = body.variantCount === undefined ? 1 : Number(body.variantCount);
  if (!Number.isInteger(variantCount) || variantCount < 1) {
    throw new ApiError("validation_failed", "variantCount must be a positive integer.", {
      fields: [{ path: "variantCount", message: "Must be an integer >= 1." }],
    });
  }
  if (variantCount > 1) {
    throw new ApiError(
      "validation_failed",
      "Multi-variant generation is not supported in v1; variantCount must be 1.",
      { fields: [{ path: "variantCount", message: "Only 1 is supported in v1." }] }
    );
  }

  const requestedAssetIds: string[] = Array.isArray(body.assetIds)
    ? body.assetIds.map((id) => String(id))
    : [];
  const compositionId = body.compositionId ? String(body.compositionId) : undefined;
  const requestedMode = parseMode(body.mode);
  const allowGeneratedGapFill = parseAllowGeneratedGapFill(body.allowGeneratedGapFill);

  let composition: CompositionPlan | null = null;
  if (compositionId) {
    composition = await store.getComposition(compositionId);
    if (!composition || composition.projectId !== projectId) {
      throw new ApiError("not_found", `Composition not found: ${compositionId}`);
    }
    // The composition must have been planned for this exact brief version,
    // otherwise its generated assets and the timeline plan would come from
    // different briefs and the stored provenance would mislink them.
    if (composition.briefVersionId !== briefVersionId) {
      throw new ApiError(
        "validation_failed",
        `Composition ${compositionId} was planned for a different brief version (${composition.briefVersionId}).`,
        {
          fields: [
            {
              path: "compositionId",
              message: "Composition brief version does not match briefVersionId.",
            },
          ],
        }
      );
    }
    if (requestedMode && composition.mode !== requestedMode) {
      throw new ApiError(
        "validation_failed",
        `Composition ${compositionId} is ${composition.mode}, not ${requestedMode}.`,
        {
          fields: [
            {
              path: "mode",
              message: "Requested mode must match the composition mode.",
            },
          ],
        }
      );
    }
  }

  let assetIds: string[];
  if (requestedAssetIds.length > 0) {
    if (composition?.mode === "hybrid" && generatedGapBeatNames(composition).length > 0) {
      requireExplicitHybridGapFillChoice(composition, allowGeneratedGapFill);
      if (allowGeneratedGapFill) {
        if (composition.status !== "ready_for_timeline") {
          throw new ApiError(
            "asset_not_ready",
            `Composition ${compositionId} has generated gap-fill assets that are not ready (status: ${composition.status}).`,
            { missingBeats: generatedGapBeatNames(composition) }
          );
        }
        assetIds = unique([...requestedAssetIds, ...composition.readyAssetIds]);
      } else {
        assetIds = requestedAssetIds;
      }
    } else {
      // Asset-driven or uploaded-only hybrid: the agent supplies the asset set explicitly.
      assetIds = requestedAssetIds;
    }
  } else if (composition) {
    requireExplicitHybridGapFillChoice(composition, allowGeneratedGapFill);
    if (composition.mode === "hybrid" && allowGeneratedGapFill === false) {
      throw new ApiError(
        "validation_failed",
        "assetIds is required to proceed uploaded-only with a hybrid composition.",
        {
          fields: [
            {
              path: "assetIds",
              message:
                "Provide uploaded assetIds, or set allowGeneratedGapFill true to use generated assets.",
            },
          ],
        }
      );
    }
    // Prompt-only: assetIds may be empty only when the composition is done.
    if (composition.status !== "ready_for_timeline") {
      throw new ApiError(
        "validation_failed",
        `Composition ${compositionId} is not ready for timeline (status: ${composition.status}).`
      );
    }
    if (composition.readyAssetIds.length === 0) {
      throw new ApiError(
        "validation_failed",
        `Composition ${compositionId} has no ready assets to build a timeline from.`
      );
    }
    assetIds = composition.readyAssetIds;
  } else {
    throw new ApiError(
      "validation_failed",
      "assetIds is required unless compositionId points to a completed composition.",
      { fields: [{ path: "assetIds", message: "Provide assetIds or a ready compositionId." }] }
    );
  }

  // Every selected asset must exist, belong to the project, and be ready.
  const resolved: V1Asset[] = [];
  for (const id of assetIds) {
    const asset = await store.getAsset(id);
    if (!asset || asset.projectId !== projectId) {
      throw new ApiError("asset_invalid", `Asset not found in project: ${id}`, {
        fields: [{ path: "assetIds", message: `Unknown asset: ${id}` }],
      });
    }
    if (asset.status !== "ready") {
      throw new ApiError("asset_not_ready", `Asset ${id} is not ready (status: ${asset.status}).`, {
        fields: [{ path: "assetIds", message: `Asset ${id} is ${asset.status}.` }],
      });
    }
    resolved.push(asset);
  }

  // Clip selection needs at least one ready visual (video/image) asset.
  if (resolved.filter((a) => a.kind !== "audio").length === 0) {
    throw new ApiError(
      "validation_failed",
      "At least one ready video or image asset is required to build a timeline."
    );
  }

  const includeCompositionGeneratedJobs = Boolean(
    composition &&
      (requestedAssetIds.length === 0 ||
        (composition.mode === "hybrid" && allowGeneratedGapFill === true))
  );
  const generatedAssetJobIds = new Set<string>(
    includeCompositionGeneratedJobs ? composition?.generatedAssetJobIds ?? [] : []
  );
  for (const asset of resolved) {
    if (asset.generatedAssetJobId) generatedAssetJobIds.add(asset.generatedAssetJobId);
  }

  const showCaptions = body.showCaptions;
  if (showCaptions !== undefined && typeof showCaptions !== "boolean") {
    throw new ApiError("validation_failed", "showCaptions must be a boolean.", {
      fields: [{ path: "showCaptions", message: "Must be true or false." }],
    });
  }

  return {
    briefVersionId,
    ...(compositionId ? { compositionId } : {}),
    ...(requestedMode ? { mode: requestedMode } : composition ? { mode: composition.mode } : {}),
    ...(allowGeneratedGapFill === undefined ? {} : { allowGeneratedGapFill }),
    assetIds,
    generatedAssetJobIds: [...generatedAssetJobIds],
    ...(showCaptions === undefined ? {} : { showCaptions }),
    variantCount,
  };
}
