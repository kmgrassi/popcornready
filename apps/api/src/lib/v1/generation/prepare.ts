import { mergeStoryContext } from "@popcorn/shared/story-context";
import { Clip, StoryContext } from "@popcorn/shared/types";
import { ApiError } from "../errors";
import { V1Store } from "../store";
import {
  CompositionPlan,
  GenerationJobInput,
  GenerationRequest,
  V1Asset,
  VideoBriefInput,
} from "@popcorn/shared/v1/types";

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
    description:
      asset.clipUnderstanding?.combinedSummary ||
      asset.assetKnowledge?.knowledgeSummary ||
      asset.description ||
      "",
    source: asset.source === "generated" ? "generated" : "upload",
  };
}

// --- Validation / resolution ----------------------------------------------

export async function prepareGeneration(
  store: V1Store,
  workspaceId: string,
  projectId: string,
  body: GenerationRequest
): Promise<GenerationJobInput> {
  const project = await store.getProject(projectId);
  if (!project || project.workspaceId !== workspaceId || project.status === "deleted") {
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
  }

  let assetIds: string[];
  if (requestedAssetIds.length > 0) {
    // Asset-driven or hybrid: the agent supplies the asset set explicitly.
    assetIds = requestedAssetIds;
  } else if (composition) {
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

  const generatedAssetJobIds = new Set<string>(composition?.generatedAssetJobIds ?? []);
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
    assetIds,
    generatedAssetJobIds: [...generatedAssetJobIds],
    ...(showCaptions === undefined ? {} : { showCaptions }),
    variantCount,
  };
}
