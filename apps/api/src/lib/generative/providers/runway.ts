import type {
  GenerateAssetRequest,
  GeneratedAssetResult,
  GenerativeProvider,
} from "@popcorn/shared/generative/types";
import { estimateCostUsd } from "../pricing";
import {
  aspectRatioFromSize,
  authedFetch,
  characterProviderSettings,
  readAsDataUri,
  requirePrompt,
} from "./shared";

const RUNWAY_BASE_URL = "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = "2024-11-06";
const RUNWAY_DEFAULT_VIDEO_MODEL = "gen4.5";

interface RunwayTask {
  id: string;
  status?:
    | "PENDING"
    | "THROTTLED"
    | "RUNNING"
    | "SUCCEEDED"
    | "FAILED"
    | "CANCELED"
    | "CANCELLED";
  output?: string[];
  failure?: string;
  failureCode?: string;
}

function normalizeRunwayVideoSeconds(value?: number): number {
  const candidate = Math.round(Number(value));
  if (!Number.isFinite(candidate)) return 5;
  if (candidate <= 5) return 5;
  return 10;
}

function runwayFetch(pathName: string, init: RequestInit): Promise<Response> {
  return authedFetch({
    baseUrl: RUNWAY_BASE_URL,
    pathName,
    init,
    apiKey: process.env.RUNWAYML_API_SECRET || process.env.RUNWAY_API_KEY,
    missingKeyMessage: "RUNWAYML_API_SECRET is not set for the Runway provider.",
    errorPrefix: "Runway",
    headers: { "X-Runway-Version": RUNWAY_API_VERSION },
  });
}

async function waitForRunwayTask(id: string): Promise<RunwayTask> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await runwayFetch(`/tasks/${id}`, { method: "GET" });
    const task = (await res.json()) as RunwayTask;
    if (
      task.status === "SUCCEEDED" ||
      task.status === "FAILED" ||
      task.status === "CANCELED" ||
      task.status === "CANCELLED"
    ) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`Runway task ${id} did not complete before timeout.`);
}

async function generateRunwayVideo(
  input: Extract<GenerateAssetRequest, { provider: "runway"; kind: "video" }>
): Promise<GeneratedAssetResult> {
  const prompt = requirePrompt(input.prompt);
  const model = input.model || RUNWAY_DEFAULT_VIDEO_MODEL;
  const duration = normalizeRunwayVideoSeconds(input.seconds);
  const firstReference = input.referencePaths?.[0];
  const endpoint = firstReference ? "/image_to_video" : "/text_to_video";
  const body = {
    model,
    promptText: prompt.slice(0, 1000),
    duration,
    ratio: aspectRatioFromSize(input.size, "1280:720", "720:1280"),
    ...(firstReference ? { promptImage: await readAsDataUri(firstReference) } : {}),
  };

  const createRes = await runwayFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const created = (await createRes.json()) as RunwayTask;
  if (!created.id) throw new Error("Runway video generation returned no task id.");

  const completed = await waitForRunwayTask(created.id);
  if (completed.status !== "SUCCEEDED") {
    throw new Error(
      `Runway video generation failed: ${completed.failureCode || completed.failure || completed.status || "unknown failure"}`
    );
  }
  const outputUrl = completed.output?.[0];
  if (!outputUrl) throw new Error("Runway video generation returned no output URL.");

  const videoRes = await fetch(outputUrl);
  if (!videoRes.ok) {
    throw new Error(`Runway output download failed (${videoRes.status}).`);
  }

  return {
    kind: "video",
    bytes: Buffer.from(await videoRes.arrayBuffer()),
    extension: "mp4",
    mimeType: videoRes.headers.get("Content-Type") || "video/mp4",
    provider: "runway",
    model,
    prompt,
    costUsd: estimateCostUsd({
      provider: "runway",
      kind: "video",
      model,
      durationSec: duration,
    }),
    providerSettings: characterProviderSettings(input),
  };
}

export const runwayProvider: GenerativeProvider = {
  name: "runway",
  async generateAsset(input) {
    if (input.provider !== "runway" || input.kind !== "video") {
      throw new Error("Runway provider currently supports video generation only.");
    }
    return generateRunwayVideo(input);
  },
};
