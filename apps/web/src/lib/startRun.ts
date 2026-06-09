// Create-project + start-generation-run flow, lifted out of the retired
// NewProjectPage so the Studio wizard (and later step PRs) share one working
// implementation. This is the only place that turns a BriefDraft into a live
// generation run; useStudioFlow.startGeneration() calls it.

import type {
  AssetKind,
  GateableGenerationStageType,
  VideoBriefInput,
} from "@popcorn/shared/v1/types";
import type { CompositionMode } from "@popcorn/shared/v1/types";
import { v1Api } from "./api-client";
import type { BriefDraft } from "../components/studio/useStudioFlow";

export interface StartRunResult {
  projectId: string;
  runId: string;
}

/** Derive a human project name from the brief goal when none was supplied. */
export function deriveProjectName(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) return "Untitled cut";
  const firstSentence = trimmed.split(/[.!?]/)[0]?.trim() || trimmed;
  return firstSentence.length > 64
    ? `${firstSentence.slice(0, 61).trim()}...`
    : firstSentence;
}

/** Build the V1 brief payload the create/run endpoints expect from a draft. */
function briefInputFromDraft(draft: BriefDraft): VideoBriefInput {
  const requiredBeats = [draft.hook, draft.bigIdea]
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    goal: draft.goal.trim(),
    targetLengthSec: draft.targetLengthSec,
    aspectRatio: draft.aspectRatio,
    platform: draft.platform,
    format: draft.format,
    style: draft.style,
    audience: draft.audience.trim() || undefined,
    constraints:
      requiredBeats.length > 0 || draft.payoff.trim() || draft.callToAction.trim()
        ? {
            requiredBeats: requiredBeats.length > 0 ? requiredBeats : undefined,
            callToAction: draft.callToAction.trim() || undefined,
          }
        : undefined,
  };
}

/** Prompt-only vs. footage-backed runs map onto composition modes. */
function compositionModeFromDraft(draft: BriefDraft): CompositionMode {
  if (draft.footageChoice === "upload") {
    return draft.footageMode === "hybrid" ? "hybrid" : "asset_driven";
  }
  return "prompt_only";
}

function assetKindForFile(file: File): AssetKind | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  return null;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

async function registerSelectedFootage(
  projectId: string,
  draft: BriefDraft,
): Promise<string[]> {
  if (draft.footageChoice !== "upload") return [];
  if (draft.selectedFootage.length === 0) {
    throw new Error("Select at least one video or image before generating with footage.");
  }

  const uploads = await Promise.all(
    draft.selectedFootage.map(async (selected) => {
      const kind = assetKindForFile(selected.file);
      if (!kind) {
        throw new Error(`Could not determine asset kind for ${selected.name}.`);
      }
      const dataBase64 = await fileToBase64(selected.file);
      const { asset } = await v1Api.registerProjectUpload(projectId, {
        source: {
          type: "multipart_upload",
          dataBase64,
          mimeType: selected.file.type || undefined,
        },
        kind,
        filename: selected.name,
        durationSec: selected.durationSec,
        userContext: {
          description: `Selected in Studio Source Footage: ${selected.name}`,
          intendedUse:
            kind === "audio" ? ["music", "voiceover", "dialogue"] : ["primary_footage"],
        },
      });
      return asset;
    }),
  );

  const visualAssetIds = uploads
    .filter((asset) => asset.kind === "video" || asset.kind === "image")
    .map((asset) => asset.id);

  if (visualAssetIds.length === 0) {
    throw new Error("Select at least one video or image before generating with footage.");
  }

  return visualAssetIds;
}

/**
 * Create the project, kick off a prompt generation run, and return the ids the
 * shell needs to poll. Throws on any API failure or a missing run id so the
 * caller can surface the error.
 */
export async function createAndStartRun(draft: BriefDraft): Promise<StartRunResult> {
  const brief = briefInputFromDraft(draft);
  const reviewGates: GateableGenerationStageType[] = draft.reviewGates;

  const { project, briefVersion } = await v1Api.createProject({
    name: draft.projectName.trim() || deriveProjectName(draft.goal),
    brief,
  });

  if (draft.footageChoice === "upload") {
    if (!briefVersion?.id) {
      throw new Error("Project was created without a brief version.");
    }
    const assetIds = await registerSelectedFootage(project.id, draft);
    const { runId } = await v1Api.startUploadedFootageGenerationRun(project.id, {
      briefVersionId: briefVersion.id,
      assetIds,
      mode: compositionModeFromDraft(draft),
      allowGeneratedGapFill: draft.footageMode === "hybrid",
      reviewGates,
      showCaptions: draft.showCaptions,
    });

    if (!runId) {
      throw new Error("Generation started without a run ID.");
    }

    return { projectId: project.id, runId };
  }

  const effectiveSeedKind =
    draft.provider === "gemini" ? "video" : draft.seedKind;

  const { runId } = await v1Api.startPromptGenerationRun(project.id, {
    brief,
    mode: compositionModeFromDraft(draft),
    allowGeneratedGapFill: true,
    provider: draft.provider,
    reviewGates,
    showCaptions: draft.showCaptions,
    seedAsset: {
      kind: effectiveSeedKind,
      provider: draft.provider,
      prompt: draft.goal.trim(),
      description: draft.goal.trim(),
      durationSec: effectiveSeedKind === "image" ? 4 : 8,
      size: draft.seedSize,
      preflightReviewIterations: 1,
    },
  });

  if (!runId) {
    throw new Error("Generation started without a run ID.");
  }

  return { projectId: project.id, runId };
}
