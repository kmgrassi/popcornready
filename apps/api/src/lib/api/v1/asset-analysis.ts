import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildSemanticAnalysis } from "@/lib/edit-graph/semantic-analysis";
import { AuthContext } from "./auth";
import { ApiError, validationError } from "./errors";
import { createJob, getJob, updateJob, V1Job } from "./jobs";
import { AnalyzeBatchInput, AssetContext } from "./schemas";
import {
  getAsset,
  getProject,
  localDir,
  mediaAnalysisDir,
  updateAssetAnalysis,
  V1Asset,
  V1AssetAnalysis,
  withLocalDir,
} from "./store";

const execFileAsync = promisify(execFile);
const ANALYSIS_VERSION = "asset-analysis.v1";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_VISION_MODEL = "gpt-4.1-mini";
const ASSET_ANALYSIS_TOOL = "summarize_asset_frames";

const assetAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    subjects: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: { type: "string" } },
    setting: { type: "string" },
    mood: { type: "string" },
    likelyUses: { type: "array", items: { type: "string" } },
    cautions: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "summary",
    "subjects",
    "actions",
    "setting",
    "mood",
    "likelyUses",
    "cautions",
    "confidence",
  ],
};

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

interface FrameSample {
  sec: number;
  storageKey: string;
  path: string;
}

interface AssetAnalysisOutcome {
  assetId: string;
  status: "succeeded" | "failed";
  sampledFrames: string[];
  error?: { code: string; message: string };
}

export function videoSampleTimes(
  durationSec: number | undefined,
  defaultSamples: number,
  maxSamples: number
): number[] {
  const sampleCount =
    durationSec && durationSec >= 120
      ? maxSamples
      : Math.min(defaultSamples, maxSamples);
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
    return [0];
  }
  if (sampleCount <= 1) return [Math.max(0, durationSec / 2)];

  const usableEnd = Math.max(0, durationSec - 0.2);
  return Array.from({ length: sampleCount }, (_, index) => {
    const ratio = (index + 1) / (sampleCount + 1);
    return Number((usableEnd * ratio).toFixed(3));
  });
}

async function runFfmpeg(args: string[]): Promise<void> {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  try {
    await execFileAsync(ffmpegPath, args);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ApiError(
        "asset_invalid",
        "ffmpeg is not available. Install ffmpeg or set FFMPEG_PATH to enable video frame analysis."
      );
    }
    const message = err instanceof Error ? err.message : "ffmpeg failed.";
    throw new ApiError("asset_invalid", message);
  }
}

function assetLocalPath(asset: V1Asset): string | null {
  if (!asset.storageKey) return null;
  return path.join(localDir(), asset.storageKey);
}

async function extractVideoFrames(args: {
  auth: AuthContext;
  projectId: string;
  asset: V1Asset;
  defaultVideoSamples: number;
  maxVideoSamples: number;
}): Promise<FrameSample[]> {
  const srcPath = assetLocalPath(args.asset);
  if (!srcPath) {
    throw new ApiError(
      "asset_invalid",
      `Asset ${args.asset.id} has no local storage key; remote video analysis requires ingest first.`
    );
  }

  const outputDir = mediaAnalysisDir(
    args.auth.workspaceId,
    args.projectId,
    args.asset.id
  );
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const times = videoSampleTimes(
    args.asset.durationSec,
    args.defaultVideoSamples,
    args.maxVideoSamples
  );
  const frames: FrameSample[] = [];

  for (const [index, sec] of times.entries()) {
    const filename = `sample-${String(index + 1).padStart(2, "0")}.jpg`;
    const outputPath = path.join(outputDir, filename);
    await runFfmpeg([
      "-y",
      "-ss",
      String(sec),
      "-i",
      srcPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ]);
    frames.push({
      sec,
      path: outputPath,
      storageKey: path.relative(localDir(), outputPath),
    });
  }

  return frames;
}

function toolResultFromOpenAIResponse(data: unknown): unknown {
  const output = (data as { output?: unknown[] })?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (
        (item as { type?: unknown })?.type === "function_call" &&
        (item as { name?: unknown })?.name === ASSET_ANALYSIS_TOOL
      ) {
        const args = (item as { arguments?: unknown })?.arguments;
        if (typeof args !== "string" || !args.trim()) return undefined;
        try {
          return JSON.parse(args);
        } catch {
          return undefined;
        }
      }
      const content = (item as { content?: unknown[] })?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (
          (part as { type?: unknown })?.type === "tool_call" &&
          (part as { name?: unknown })?.name === ASSET_ANALYSIS_TOOL
        ) {
          const input = (part as { input?: unknown })?.input;
          if (input && typeof input === "object" && !Array.isArray(input)) {
            return input;
          }
        }
      }
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

async function summarizeWithOpenAI(
  asset: V1Asset,
  frames: FrameSample[],
  userContext: Record<string, unknown> | undefined
): Promise<V1AssetAnalysis["observations"]> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_ASSET_ANALYSIS_MODEL || DEFAULT_OPENAI_VISION_MODEL;
  if (!apiKey) {
    return {
      summary: `Sampled ${frames.length} frame${frames.length === 1 ? "" : "s"} from ${asset.filename}; vision analysis was skipped because OPENAI_API_KEY is not set.`,
      subjects: [],
      actions: [],
      likelyUses: ["primary_footage"],
      cautions: ["Vision analysis not run."],
      confidence: "low",
      model: { provider: "openai", model },
    };
  }

  const imageParts = await Promise.all(
    frames.map(async (frame) => ({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${(await fs.readFile(frame.path)).toString("base64")}`,
    }))
  );
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      tools: [
        {
          type: "function",
          name: ASSET_ANALYSIS_TOOL,
          description:
            "Summarize sampled uploaded-video frames for an editing agent.",
          parameters: assetAnalysisSchema,
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: ASSET_ANALYSIS_TOOL },
      parallel_tool_calls: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Summarize this uploaded video from sampled frames for an editing agent. Call the required tool with summary, subjects, actions, setting, mood, likelyUses, cautions, and confidence.",
            },
            {
              type: "input_text",
              text: JSON.stringify({
                filename: asset.filename,
                durationSec: asset.durationSec,
                userContext,
                sampleTimesSec: frames.map((frame) => frame.sec),
              }),
            },
            ...imageParts,
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new ApiError(
      "model_output_invalid",
      `OpenAI asset analysis failed with ${response.status}.`
    );
  }

  const parsed = toolResultFromOpenAIResponse(await response.json()) as
    | Record<string, unknown>
    | undefined;
  if (!parsed) {
    throw new ApiError(
      "model_output_invalid",
      `OpenAI asset analysis did not call ${ASSET_ANALYSIS_TOOL}.`
    );
  }

  const confidence = String(parsed.confidence || "medium");
  return {
    summary: String(parsed.summary || ""),
    subjects: stringArray(parsed.subjects),
    actions: stringArray(parsed.actions),
    setting:
      typeof parsed.setting === "string" && parsed.setting.trim()
        ? parsed.setting.trim()
        : undefined,
    mood:
      typeof parsed.mood === "string" && parsed.mood.trim()
        ? parsed.mood.trim()
        : undefined,
    likelyUses: stringArray(parsed.likelyUses),
    cautions: stringArray(parsed.cautions),
    confidence:
      confidence === "high" || confidence === "medium" || confidence === "low"
        ? confidence
        : "medium",
    model: { provider: "openai", model },
  };
}

function mergedContext(
  asset: V1Asset,
  observations: V1AssetAnalysis["observations"] | undefined
): AssetContext | undefined {
  if (!observations) return asset.context;
  return {
    ...asset.context,
    summary: observations.summary || asset.context?.summary,
    recommendedRoles:
      observations.likelyUses.length > 0
        ? observations.likelyUses
        : asset.context?.recommendedRoles,
  };
}

async function analyzeOneAsset(args: {
  auth: AuthContext;
  projectId: string;
  assetId: string;
  input: AnalyzeBatchInput;
}): Promise<AssetAnalysisOutcome> {
  try {
    const asset = await getAsset(args.auth.workspaceId, args.projectId, args.assetId);
    if (asset.kind !== "video") {
      throw new ApiError(
        "asset_invalid",
        `Asset ${asset.id} is ${asset.kind}; PR2 analysis currently supports video assets.`
      );
    }

    const frames = args.input.analysisOptions.sampleFrames
      ? await extractVideoFrames({
          auth: args.auth,
          projectId: args.projectId,
          asset,
          defaultVideoSamples: args.input.analysisOptions.defaultVideoSamples,
          maxVideoSamples: args.input.analysisOptions.maxVideoSamples,
        })
      : [];
    const observations = await summarizeWithOpenAI(asset, frames, args.input.userContext);
    const now = new Date().toISOString();
    const context = mergedContext(asset, observations);
    const analysis: V1AssetAnalysis = {
      schemaVersion: "assetAnalysis.v1",
      status: "succeeded",
      analyzedAt: now,
      analysisVersion: ANALYSIS_VERSION,
      sampledFrames: frames.map((frame) => frame.storageKey),
      observations,
    };

    await updateAssetAnalysis(args.auth.workspaceId, args.projectId, asset.id, {
      context,
      semanticAnalysis: buildSemanticAnalysis({
        id: asset.id,
        kind: asset.kind,
        durationSec: asset.durationSec,
        filename: asset.filename,
        source: asset.source,
        context,
        provenance: asset.provenance,
      }),
      analysis,
    });

    return {
      assetId: asset.id,
      status: "succeeded",
      sampledFrames: analysis.sampledFrames,
    };
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "asset_analysis_failed";
    const message = err instanceof Error ? err.message : "Asset analysis failed.";
    try {
      const asset = await getAsset(args.auth.workspaceId, args.projectId, args.assetId);
      await updateAssetAnalysis(args.auth.workspaceId, args.projectId, asset.id, {
        analysis: {
          schemaVersion: "assetAnalysis.v1",
          status: "failed",
          analyzedAt: new Date().toISOString(),
          analysisVersion: ANALYSIS_VERSION,
          sampledFrames: [],
          error: { code, message },
        },
      });
    } catch {
      // If the asset does not exist, the batch result still records the failure.
    }
    return {
      assetId: args.assetId,
      status: "failed",
      sampledFrames: [],
      error: { code, message },
    };
  }
}

async function runAnalysisJob(args: {
  auth: AuthContext;
  projectId: string;
  input: AnalyzeBatchInput;
  job: V1Job;
}): Promise<V1Job> {
  await updateJob(args.job.id, {
    status: "running",
    progress: { currentStep: "asset_analysis", percent: 5 },
  });

  const results: AssetAnalysisOutcome[] = [];
  for (const [index, assetId] of args.input.assetIds.entries()) {
    results.push(
      await analyzeOneAsset({
        auth: args.auth,
        projectId: args.projectId,
        assetId,
        input: args.input,
      })
    );
    await updateJob(args.job.id, {
      progress: {
        currentStep: "asset_analysis",
        percent: Math.round(((index + 1) / args.input.assetIds.length) * 95),
      },
    });
  }

  const failed = results.filter((result) => result.status === "failed");
  return updateJob(args.job.id, {
    status: failed.length === results.length ? "failed" : "succeeded",
    progress: { currentStep: "asset_analysis", percent: 100 },
    result: {
      assetIds: results.map((result) => result.assetId),
      analyzedAssetIds: results
        .filter((result) => result.status === "succeeded")
        .map((result) => result.assetId),
      results,
    },
    error:
      failed.length === results.length
        ? { code: "asset_analysis_failed", message: "All requested assets failed analysis." }
        : null,
  });
}

function startAnalysisJob(args: {
  auth: AuthContext;
  projectId: string;
  input: AnalyzeBatchInput;
  job: V1Job;
}): void {
  const queuedLocalDir = localDir();
  void withLocalDir(queuedLocalDir, () =>
    runAnalysisJob(args).catch(async (err) => {
      const message = err instanceof Error ? err.message : "Asset analysis failed.";
      await updateJob(args.job.id, {
        status: "failed",
        progress: { currentStep: "asset_analysis", percent: 100 },
        error: { code: "asset_analysis_failed", message },
      });
    })
  );
}

export async function analyzeAssetBatch(args: {
  auth: AuthContext;
  projectId: string;
  input: AnalyzeBatchInput;
}): Promise<ApiResult> {
  await getProject(args.auth.workspaceId, args.projectId);
  if (args.input.assetIds.length === 0) {
    throw validationError("The request body is invalid.", [
      { path: "assetIds", message: "Must be a non-empty array of asset IDs." },
    ]);
  }

  const job = await createJob({
    workspaceId: args.auth.workspaceId,
    projectId: args.projectId,
    type: "asset_analysis",
    status: "queued",
    progress: { currentStep: "queued", percent: 0 },
    error: null,
  });

  startAnalysisJob({ ...args, job });
  return { status: 202, body: { job } };
}

export async function getAssetAnalysisJob(args: {
  auth: AuthContext;
  projectId: string;
  jobId: string;
}): Promise<ApiResult> {
  const job = await getJob(args.jobId);
  if (
    !job ||
    job.workspaceId !== args.auth.workspaceId ||
    job.projectId !== args.projectId ||
    job.type !== "asset_analysis"
  ) {
    throw new ApiError("not_found", `Job not found: ${args.jobId}`, { status: 404 });
  }
  return { status: 200, body: { job } };
}
