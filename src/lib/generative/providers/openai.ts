import path from "path";
import {
  GenerateAssetRequest,
  GeneratedAssetResult,
  GenerativeProvider,
  OpenAIImageModel,
  OpenAIImageSize,
  OpenAIVideoModel,
  OpenAIVideoRequest,
  OpenAIVideoSeconds,
  normalizeOpenAIImageSize,
  normalizeOpenAIVideoSeconds,
  normalizeOpenAIVideoSize,
} from "../types";
import { estimateCostUsd } from "../pricing";
import {
  authedFetch,
  characterProviderSettings,
  readAsBlob,
  requirePrompt,
} from "./shared";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_IMAGE_MODEL: OpenAIImageModel = "gpt-image-1.5";
const OPENAI_DEFAULT_VIDEO_MODEL: OpenAIVideoModel = "sora-2";
const DEFAULT_OPENAI_VIDEO_POLL_MS = 5_000;
const DEFAULT_OPENAI_VIDEO_TIMEOUT_MS = 8 * 60 * 1_000;

interface OpenAIImageGenerationPayload {
  model: string;
  prompt: string;
  size?: OpenAIImageSize;
  quality?: "low" | "medium" | "high" | "auto";
}

interface OpenAIVideoGenerationPayload {
  model: string;
  prompt: string;
  size: string;
  seconds: OpenAIVideoSeconds;
}

type OpenAIVideoStatus = "queued" | "in_progress" | "completed" | "failed";

interface OpenAIVideoJob {
  id: string;
  status: OpenAIVideoStatus;
  error?: {
    code?: string;
    message?: string;
  };
}

interface OpenAIVideoFetchOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

function buildOpenAIImagePayload(
  input: Extract<GenerateAssetRequest, { provider: "openai"; kind: "image" }>
): OpenAIImageGenerationPayload {
  return {
    model: input.model || OPENAI_DEFAULT_IMAGE_MODEL,
    prompt: requirePrompt(input.prompt),
    ...(input.size ? { size: normalizeOpenAIImageSize(input.size) } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
  };
}

function buildOpenAIVideoPayload(
  input: OpenAIVideoRequest
): OpenAIVideoGenerationPayload {
  return {
    model: input.model || OPENAI_DEFAULT_VIDEO_MODEL,
    prompt: requirePrompt(input.prompt),
    size: normalizeOpenAIVideoSize(input.size),
    seconds: normalizeOpenAIVideoSeconds(input.seconds),
  };
}

function openaiFetch(pathName: string, init: RequestInit): Promise<Response> {
  return authedFetch({
    baseUrl: OPENAI_BASE_URL,
    pathName,
    init,
    apiKey: process.env.OPENAI_API_KEY,
    missingKeyMessage: "OPENAI_API_KEY is not set for the OpenAI provider.",
    errorPrefix: "OpenAI",
  });
}

export async function getOpenAIVideoById(
  id: string,
  options: OpenAIVideoFetchOptions = {}
): Promise<OpenAIVideoJob> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_OPENAI_VIDEO_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_VIDEO_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const response = await openaiFetch(`/videos/${id}`, { method: "GET" });
    const job = (await response.json()) as OpenAIVideoJob;

    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() >= deadline) {
      throw new Error(`OpenAI video job ${id} did not complete within ${timeoutMs}ms.`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function downloadOpenAIVideoById(id: string): Promise<Buffer> {
  const response = await openaiFetch(`/videos/${id}/content`, { method: "GET" });
  return Buffer.from(await response.arrayBuffer());
}

async function generateOpenAIImage(
  input: Extract<GenerateAssetRequest, { provider: "openai"; kind: "image" }>
): Promise<GeneratedAssetResult> {
  const payload = buildOpenAIImagePayload(input);
  const referencePaths = input.referencePaths || [];

  if (referencePaths.length > 0) {
    const form = new FormData();
    form.set("model", payload.model);
    form.set("prompt", payload.prompt);
    if (payload.size) form.set("size", payload.size);
    if (payload.quality) form.set("quality", payload.quality);
    for (const filePath of referencePaths) {
      form.append("image[]", await readAsBlob(filePath), path.basename(filePath));
    }

    const res = await openaiFetch("/images/edits", {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI image edit returned no image data.");
    return openAIImageResult(input, payload, Buffer.from(b64, "base64"));
  }

  const res = await openaiFetch("/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: payload.model,
      prompt: payload.prompt,
      ...(payload.size ? { size: payload.size } : {}),
      ...(payload.quality ? { quality: payload.quality } : {}),
    }),
  });
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image generation returned no image data.");
  return openAIImageResult(input, payload, Buffer.from(b64, "base64"));
}

function openAIImageResult(
  input: Extract<GenerateAssetRequest, { provider: "openai"; kind: "image" }>,
  payload: OpenAIImageGenerationPayload,
  bytes: Buffer
): GeneratedAssetResult {
  return {
    kind: "image",
    bytes,
    extension: "png",
    mimeType: "image/png",
    provider: "openai",
    model: payload.model,
    prompt: payload.prompt,
    costUsd: estimateCostUsd({
      provider: "openai",
      kind: "image",
      model: payload.model,
    }),
    providerSettings: characterProviderSettings(input),
  };
}

async function generateOpenAIVideo(
  input: OpenAIVideoRequest
): Promise<GeneratedAssetResult> {
  const payload = buildOpenAIVideoPayload(input);
  const form = new FormData();
  form.set("model", payload.model);
  form.set("prompt", payload.prompt);
  form.set("size", payload.size);
  form.set("seconds", String(payload.seconds));

  const firstReference = input.referencePaths?.[0];
  if (firstReference) {
    form.set(
      "input_reference",
      await readAsBlob(firstReference),
      path.basename(firstReference)
    );
  }

  const createRes = await openaiFetch("/videos", {
    method: "POST",
    body: form,
  });
  const createPayload = await createRes.json();
  const id = createPayload?.id;
  if (!id) throw new Error("OpenAI video generation returned no job id.");

  const completedVideo = await getOpenAIVideoById(id);
  if (completedVideo.status !== "completed") {
    const failure = completedVideo.error?.message
      ? `OpenAI video generation failed: ${completedVideo.error.message}`
      : `OpenAI video generation did not complete: ${completedVideo.status}`;
    throw new Error(failure);
  }

  return {
    kind: "video",
    bytes: await downloadOpenAIVideoById(id),
    extension: "mp4",
    mimeType: "video/mp4",
    provider: "openai",
    model: payload.model,
    prompt: payload.prompt,
    costUsd: estimateCostUsd({
      provider: "openai",
      kind: "video",
      model: payload.model,
      durationSec: payload.seconds,
    }),
    providerSettings: characterProviderSettings(input),
  };
}

export const openAIProvider: GenerativeProvider = {
  name: "openai",
  async generateAsset(input) {
    if (input.provider !== "openai") {
      throw new Error("OpenAI provider currently supports image and video generation only.");
    }
    if (input.kind === "image") return generateOpenAIImage(input);
    if (input.kind === "video") return generateOpenAIVideo(input);
    throw new Error("OpenAI provider currently supports image and video generation only.");
  },
};
