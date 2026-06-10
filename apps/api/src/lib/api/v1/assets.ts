// Asset registration for the v1 agent API.
//
// PR1 supports two source modes:
//   - remote_url: persist metadata now; downloading/inspection is an asset_ingest
//     job handled in a later PR, so the asset starts in status "pending".
//   - local_path (AUTH_MODE=local only): copy the file into managed local storage
//     so later operations never depend on the original source file, status "ready".
//
// generated sources are out of scope for PR1.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { AuthContext } from "./auth";
import { sha256Hex } from "./asset-graph";
import { buildSemanticAnalysis } from "../../edit-graph/semantic-analysis";
import { ApiError } from "./errors";
import {
  AgentAssetContext,
  AssetInventoryInput,
  AssetInventoryReport,
  AssetKnowledge,
  AssetKnowledgeSummary,
  AssetUse,
  AssetKind,
  ClipUnderstanding,
  KnowledgeGap,
  LearningAction,
  RegisterAssetInput,
  SCHEMA_VERSIONS,
  UpdateAssetContextInput,
  UserAssetContext,
  inferKindFromName,
} from "./schemas";
import {
  addAsset,
  getProject,
  listAssets,
  localDir,
  mediaUploadDir,
  updateAsset as updateStoredAsset,
  V1Asset,
} from "./store";

const ASSET_KNOWLEDGE_ANALYSIS_VERSION = "assetKnowledge.v1";

function basename(input: string): string {
  try {
    if (/^https?:\/\//.test(input)) {
      const url = new URL(input);
      const fromPath = url.pathname.split("/").filter(Boolean).pop();
      return fromPath || url.hostname;
    }
  } catch {
    // fall through to path basename
  }
  return path.basename(input);
}

function resolveKind(explicit: AssetKind | undefined, filename: string): AssetKind {
  const kind = explicit || inferKindFromName(filename);
  if (!kind) {
    throw new ApiError(
      "asset_invalid",
      "Could not determine asset kind from the filename. Provide `kind` (video, image, or audio)."
    );
  }
  return kind;
}

function originFor(asset: Pick<V1Asset, "source" | "provenance">): AssetKnowledge["origin"] {
  if (asset.source.type === "generated" || asset.provenance) return "generated";
  if (asset.source.type === "remote_url") return "imported";
  return "uploaded";
}

function usesForKind(kind: AssetKind, context?: UserAssetContext): AssetUse[] {
  if (context?.intendedUse?.length) return context.intendedUse;
  if (kind === "audio") return ["music", "voiceover", "dialogue"];
  if (kind === "image") return ["primary_footage", "style_reference"];
  return ["primary_footage", "b_roll"];
}

function factsFromAsset(asset: V1Asset): AssetKnowledge["knownFacts"] {
  const facts: AssetKnowledge["knownFacts"] = [
    { field: "filename", value: asset.filename, confidence: "high", source: "metadata" },
    { field: "kind", value: asset.kind, confidence: "high", source: "metadata" },
  ];
  if (typeof asset.durationSec === "number") {
    facts.push({
      field: "durationSec",
      value: String(asset.durationSec),
      confidence: "high",
      source: "metadata",
    });
  }
  if (asset.context?.summary) {
    facts.push({
      field: "summary",
      value: asset.context.summary,
      confidence: "medium",
      source: "user",
    });
  }
  if (asset.userContext?.description) {
    facts.push({
      field: "userContext.description",
      value: asset.userContext.description,
      confidence: "high",
      source: "user",
    });
  }
  if (asset.agentContext?.summary) {
    facts.push({
      field: "agentContext.summary",
      value: asset.agentContext.summary,
      confidence: asset.agentContext.confidence,
      source: "agent",
    });
  }
  if (asset.context?.transcriptText || asset.userContext?.transcriptHint) {
    facts.push({
      field: "transcript",
      value: asset.context?.transcriptText || asset.userContext?.transcriptHint || "",
      confidence: asset.context?.transcriptText ? "medium" : "low",
      source: asset.context?.transcriptText ? "transcript" : "user",
    });
  }
  return facts;
}

function gapsForAsset(asset: V1Asset): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = [];
  const hasSummary = Boolean(
    asset.agentContext?.summary || asset.userContext?.description || asset.context?.summary
  );
  if (!hasSummary) {
    gaps.push({
      field: `${asset.id}.summary`,
      question: `What does ${asset.filename} contain?`,
      canInferAutomatically: true,
      suggestedAction: asset.kind === "video" ? "sample_video" : asset.kind === "image" ? "analyze_image" : "transcribe_audio",
    });
  }
  if (asset.kind === "audio" && !asset.context?.transcriptText && !asset.userContext?.audioNotes) {
    gaps.push({
      field: `${asset.id}.audio_content`,
      question: `Is ${asset.filename} music, dialogue, narration, or another audio role?`,
      canInferAutomatically: true,
      suggestedAction: "transcribe_audio",
    });
  }
  if (!asset.userContext?.intendedUse?.length && !asset.context?.recommendedRoles?.length) {
    gaps.push({
      field: `${asset.id}.intendedUse`,
      question: `How should ${asset.filename} be used in the edit?`,
      canInferAutomatically: false,
      suggestedAction: "ask_user",
    });
  }
  return gaps;
}

function scoreFor(asset: V1Asset): number {
  if (asset.agentContext?.confidence === "high") return 0.8;
  if (asset.agentContext?.confidence === "medium") return 0.6;
  if (asset.agentContext?.confidence === "low") return 0.45;
  if (asset.userContext?.description || asset.context?.summary) return 0.35;
  if (asset.durationSec !== undefined || asset.storageKey || asset.remoteUrl) return 0.2;
  return 0;
}

function summaryFor(asset: V1Asset): string {
  const user = asset.userContext;
  const parts = [
    asset.agentContext?.summary,
    user?.description,
    asset.context?.summary,
    user?.title ? `Title: ${user.title}` : undefined,
    user?.event ? `Event: ${user.event}` : undefined,
    user?.location ? `Location: ${user.location}` : undefined,
    user?.people?.length ? `People: ${user.people.join(", ")}` : undefined,
    user?.notableMoments?.length ? `Notable moments: ${user.notableMoments.join("; ")}` : undefined,
    asset.context?.transcriptText
      ? `Transcript: ${asset.context.transcriptText}`
      : undefined,
    user?.transcriptHint ? `Transcript hint: ${user.transcriptHint}` : undefined,
    user?.audioNotes ? `Audio: ${user.audioNotes}` : undefined,
    asset.context?.recommendedRoles?.length
      ? `Roles: ${asset.context.recommendedRoles.join(", ")}`
      : undefined,
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.join(" | ") || "";
}

function buildClipUnderstanding(asset: V1Asset): ClipUnderstanding {
  const moments = asset.context?.moments ?? [];
  return {
    assetId: asset.id,
    source: originFor(asset) === "generated" ? "generated" : "upload",
    userContext: asset.userContext,
    agentContext: asset.agentContext,
    combinedSummary: summaryFor(asset),
    timelineHints: {
      mustUse: Boolean(asset.userContext?.mustUse),
      avoid: Boolean(asset.userContext?.avoid),
      preferredBeats: [
        ...(asset.userContext?.tags ?? []),
        ...(asset.context?.recommendedRoles ?? []),
      ],
      bestStartSec: moments[0]?.startSec,
      bestEndSec: moments[0]?.endSec,
    },
    provenance: {
      userContextUpdatedAt: asset.userContext ? asset.updatedAt : undefined,
      analyzedAt: asset.agentContext ? asset.updatedAt : undefined,
      analysisVersion: ASSET_KNOWLEDGE_ANALYSIS_VERSION,
      sampledFrameAssetIds:
        asset.agentContext && "sampledFrames" in asset.agentContext
          ? asset.agentContext.sampledFrames
          : asset.agentContext?.sampledAssetIds ?? [],
    },
  };
}

function buildAssetKnowledge(asset: V1Asset, now = new Date().toISOString()): AssetKnowledge {
  const unknowns = gapsForAsset(asset);
  const likelyUses = [
    ...new Set([
      ...(asset.agentContext?.likelyUses ?? []),
      ...(asset.userContext?.intendedUse ?? []),
      ...usesForKind(asset.kind, asset.userContext),
    ]),
  ];
  return {
    assetId: asset.id,
    mediaType: asset.kind,
    origin: originFor(asset),
    userContext: asset.userContext,
    agentContext: asset.agentContext,
    knowledgeScore: scoreFor(asset),
    knowledgeSummary: summaryFor(asset),
    knownFacts: factsFromAsset(asset),
    unknowns,
    likelyUses,
    constraints: [
      ...(asset.userContext?.mustUse ? [{ type: "must_use" as const }] : []),
      ...(asset.userContext?.avoid ? [{ type: "avoid" as const }] : []),
    ],
    relationships: [],
    provenance: {
      createdAt: asset.assetKnowledge?.provenance.createdAt ?? now,
      updatedAt: now,
      analysisVersion: ASSET_KNOWLEDGE_ANALYSIS_VERSION,
      model: asset.agentContext?.model,
      sampledAssetIds: asset.agentContext?.sampledAssetIds ?? [],
    },
  };
}

function semanticContextFor(asset: V1Asset) {
  const combinedSummary = summaryFor(asset);
  return {
    summary: combinedSummary || asset.context?.summary,
    recommendedRoles: [
      ...new Set([
        ...(asset.context?.recommendedRoles ?? []),
        ...(asset.userContext?.intendedUse ?? []),
        ...(asset.userContext?.tags ?? []),
      ]),
    ],
    transcriptText: asset.context?.transcriptText || asset.userContext?.transcriptHint,
    moments: asset.context?.moments,
  };
}

export function withDerivedAssetKnowledge(asset: V1Asset, now?: string): V1Asset {
  const derived = { ...asset };
  derived.assetKnowledge = buildAssetKnowledge(derived, now);
  derived.clipUnderstanding = buildClipUnderstanding(derived);
  derived.semanticAnalysis = buildSemanticAnalysis({
    id: derived.id,
    kind: derived.kind,
    durationSec: derived.durationSec,
    filename: derived.filename,
    source: derived.source,
    context: semanticContextFor(derived),
  });
  return derived;
}

async function addAssetWithDerivedKnowledge(
  auth: AuthContext,
  projectId: string,
  asset: V1Asset,
  now: string
): Promise<V1Asset> {
  const created = await addAsset(asset);
  return updateStoredAsset(auth.workspaceId, projectId, created.id, (stored) => {
    const derived = withDerivedAssetKnowledge(stored, now);
    stored.assetKnowledge = derived.assetKnowledge;
    stored.clipUnderstanding = derived.clipUnderstanding;
    stored.semanticAnalysis = derived.semanticAnalysis;
  });
}

export async function registerAsset(
  auth: AuthContext,
  projectId: string,
  input: RegisterAssetInput
): Promise<V1Asset> {
  // Ensure the project exists within the resolved workspace.
  await getProject(auth.workspaceId, projectId);

  const now = new Date().toISOString();

  if (input.source.type === "remote_url") {
    const filename = input.filename || basename(input.source.url);
    const kind = resolveKind(input.kind, filename);
    const asset: V1Asset = {
      // Placeholder; addAsset omits it on insert and the DB assigns the real id.
      id: "",
      schemaVersion: SCHEMA_VERSIONS.asset,
      workspaceId: auth.workspaceId,
      projectId,
      kind,
      filename,
      status: "pending",
      source: input.source,
      remoteUrl: input.source.url,
      durationSec: input.durationSec,
      context: input.context,
      userContext: input.userContext,
      agentContext: input.agentContext,
      createdAt: now,
      updatedAt: now,
    };
    return addAssetWithDerivedKnowledge(auth, projectId, asset, now);
  }

  if (input.source.type === "local_path") {
    if (!auth.isLocal) {
      throw new ApiError(
        "validation_failed",
        "local_path assets are only allowed when AUTH_MODE=local."
      );
    }
    const srcPath = input.source.path;
    let stat;
    try {
      stat = await fs.stat(srcPath);
    } catch {
      throw new ApiError("asset_invalid", `Local file not found: ${srcPath}`);
    }
    if (!stat.isFile()) {
      throw new ApiError("asset_invalid", `Local path is not a file: ${srcPath}`);
    }

    const filename = input.filename || basename(srcPath);
    const kind = resolveKind(input.kind, filename);

    const ext = path.extname(srcPath);
    const destDir = mediaUploadDir(auth.workspaceId, projectId);
    await fs.mkdir(destDir, { recursive: true });
    // The on-disk byte name is a storage key (its own namespace), NOT the DB row
    // id — the DB assigns the asset id. Use a random key so the bytes can land
    // before the row exists.
    const destPath = path.join(destDir, `${randomUUID()}${ext}`);
    await fs.copyFile(srcPath, destPath);
    const bytes = await fs.readFile(destPath);
    const storageKey = path.relative(localDir(), destPath);

    const asset: V1Asset = {
      // Placeholder; addAsset omits it on insert and the DB assigns the real id.
      id: "",
      schemaVersion: SCHEMA_VERSIONS.asset,
      workspaceId: auth.workspaceId,
      projectId,
      kind,
      filename,
      status: "ready",
      source: { type: "local_path", path: srcPath },
      storageKey,
      durationSec: input.durationSec,
      context: input.context,
      userContext: input.userContext,
      agentContext: input.agentContext,
      contentHash: sha256Hex(bytes),
      createdAt: now,
      updatedAt: now,
    };
    return addAssetWithDerivedKnowledge(auth, projectId, asset, now);
  }

  if (input.source.type === "multipart_upload") {
    const filename = input.filename || `${randomUUID()}.bin`;
    const kind = resolveKind(input.kind, filename);
    const dataBase64 = input.source.dataBase64;
    if (!dataBase64) {
      throw new ApiError("asset_invalid", "Uploaded asset bytes are required.");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(dataBase64, "base64");
    } catch {
      throw new ApiError("asset_invalid", "Uploaded asset bytes are not valid base64.");
    }
    if (bytes.length === 0) {
      throw new ApiError("asset_invalid", "Uploaded asset bytes are empty.");
    }

    const ext = path.extname(filename);
    const destDir = mediaUploadDir(auth.workspaceId, projectId);
    await fs.mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, `${randomUUID()}${ext}`);
    await fs.writeFile(destPath, bytes);
    const storageKey = path.relative(localDir(), destPath);

    const asset: V1Asset = {
      id: "",
      schemaVersion: SCHEMA_VERSIONS.asset,
      workspaceId: auth.workspaceId,
      projectId,
      kind,
      filename,
      status: "ready",
      source: {
        type: "multipart_upload",
        ...(input.source.mimeType ? { mimeType: input.source.mimeType } : {}),
      },
      storageKey,
      durationSec: input.durationSec,
      context: input.context,
      userContext: input.userContext,
      agentContext: input.agentContext,
      contentHash: sha256Hex(bytes),
      createdAt: now,
      updatedAt: now,
    };
    return addAssetWithDerivedKnowledge(auth, projectId, asset, now);
  }

  throw new ApiError(
    "validation_failed",
    `Asset source "${input.source.type}" is not supported yet. Use remote_url, local_path, or multipart_upload.`
  );
}

export async function updateAssetContext(
  auth: AuthContext,
  projectId: string,
  assetId: string,
  input: UpdateAssetContextInput
): Promise<V1Asset> {
  await getProject(auth.workspaceId, projectId);
  return updateStoredAsset(auth.workspaceId, projectId, assetId, (asset) => {
    if (input.context !== undefined) {
      asset.context = {
        ...(asset.context ?? {}),
        ...input.context,
      };
    }
    if (input.userContext !== undefined) {
      if (input.userContext === null) delete asset.userContext;
      else {
        asset.userContext = {
          ...(asset.userContext ?? {}),
          ...input.userContext,
        };
      }
    }
    if (input.agentContext !== undefined) {
      if (input.agentContext === null) delete asset.agentContext;
      else asset.agentContext = input.agentContext as AgentAssetContext;
    }
    const derived = withDerivedAssetKnowledge(asset);
    asset.assetKnowledge = derived.assetKnowledge;
    asset.clipUnderstanding = derived.clipUnderstanding;
    asset.semanticAnalysis = derived.semanticAnalysis;
  });
}

function confidenceFor(asset: V1Asset): AssetKnowledgeSummary["confidence"] {
  const score = asset.assetKnowledge?.knowledgeScore ?? scoreFor(asset);
  if (score >= 0.7) return "high";
  if (score >= 0.35) return "medium";
  return "low";
}

function summaryForInventory(asset: V1Asset): AssetKnowledgeSummary {
  const knowledge = asset.assetKnowledge ?? buildAssetKnowledge(asset);
  return {
    assetId: asset.id,
    mediaType: asset.kind,
    known: knowledge.knownFacts.map((fact) => `${fact.field}: ${fact.value}`),
    unknown: knowledge.unknowns,
    likelyUses: knowledge.likelyUses,
    confidence: confidenceFor(asset),
  };
}

function learningActionsFor(asset: V1Asset): LearningAction[] {
  const seen = new Set<string>();
  return gapsForAsset(asset)
    .filter((gap) => gap.canInferAutomatically || gap.suggestedAction === "ask_user")
    .map((gap) => ({
      assetId: asset.id,
      action: gap.suggestedAction,
      reason: gap.question,
    }))
    .filter((action) => {
      const key = `${action.assetId}:${action.action}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function coverage(total: number, known: number): "none" | "partial" | "complete" {
  if (total === 0 || known === 0) return "none";
  return known >= total ? "complete" : "partial";
}

export async function inventoryAssets(
  auth: AuthContext,
  projectId: string,
  input: AssetInventoryInput
): Promise<AssetInventoryReport> {
  await getProject(auth.workspaceId, projectId);
  const { items } = await listAssets(auth.workspaceId, projectId, 100, null);
  const requested = input.assetIds?.length
    ? items.filter((asset) => input.assetIds?.includes(asset.id))
    : items;
  const assets = input.includeExistingContext
    ? requested
    : requested.map((asset) => ({
        ...asset,
        context: undefined,
        userContext: undefined,
        agentContext: undefined,
        assetKnowledge: undefined,
        clipUnderstanding: undefined,
        semanticAnalysis: undefined,
      }));
  const summaries = assets.map(summaryForInventory);
  const globalUnknowns = summaries.flatMap((summary) => summary.unknown);
  const knownSummaryCount = assets.filter((asset) => summaryFor(asset)).length;
  const videoAssets = assets.filter((asset) => asset.kind === "video");
  const imageAssets = assets.filter((asset) => asset.kind === "image");
  const audioAssets = assets.filter((asset) => asset.kind === "audio");

  return {
    projectId,
    assets: summaries,
    globalKnowns: summaries.flatMap((summary) => summary.known),
    globalUnknowns,
    recommendedLearningActions: assets.flatMap(learningActionsFor),
    coverageEstimate: {
      video: coverage(videoAssets.length, videoAssets.filter((asset) => summaryFor(asset)).length),
      images: coverage(imageAssets.length, imageAssets.filter((asset) => summaryFor(asset)).length),
      audio: coverage(audioAssets.length, audioAssets.filter((asset) => summaryFor(asset)).length),
      characters: coverage(
        assets.length,
        assets.filter((asset) => asset.userContext?.characterNames?.length).length
      ),
      brandsOrLogos: coverage(
        assets.length,
        assets.filter((asset) =>
          [...(asset.context?.recommendedRoles ?? []), ...(asset.userContext?.tags ?? [])].some(
            (value) => /logo|brand/i.test(value)
          )
        ).length
      ),
    },
  };
}
