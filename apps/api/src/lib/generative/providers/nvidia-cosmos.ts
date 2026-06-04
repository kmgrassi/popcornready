import type {
  GenerateAssetRequest,
  GeneratedAssetResult,
  GenerativeProvider,
} from "@popcorn/shared/generative/types";
import { estimateCostUsd } from "../pricing";
import {
  aspectRatioFromSize,
  characterProviderSettings,
  readAsDataUri,
  requirePrompt,
} from "./shared";

const DEFAULT_NVIDIA_VIDEO_GENERATION_BASE_URL =
  "https://ai.api.nvidia.com/v1/genai";
const DEFAULT_NVIDIA_COSMOS3_NANO_MODEL = "nvidia/cosmos3-nano";

type NvidiaCosmosResponse = {
  b64_video?: string;
  seed?: number;
  upsampled_prompt?: string;
  error?: unknown;
  message?: unknown;
};

type NvidiaCosmosRequestBody = {
  prompt: string;
  negative_prompt?: string;
  image?: string;
  seed?: number;
  resolution?: string;
  num_output_frames?: number;
  fps?: number;
  steps?: number;
  guidance_scale?: number;
};

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function nvidiaBaseUrl() {
  return trimTrailingSlash(
    process.env.NVIDIA_VIDEO_GENERATION_BASE_URL ||
      DEFAULT_NVIDIA_VIDEO_GENERATION_BASE_URL
  );
}

function nvidiaModel(inputModel?: string) {
  return (
    inputModel ||
    process.env.NVIDIA_VIDEO_GENERATION_MODEL ||
    DEFAULT_NVIDIA_COSMOS3_NANO_MODEL
  );
}

function endpointUrl(baseUrl: string, model: string) {
  const [publisher, ...slugParts] = model.split("/");
  const slug = slugParts.join("/");
  if (!publisher || !slug) {
    throw new Error(
      "NVIDIA video generation model must use publisher/model format."
    );
  }
  return `${baseUrl}/${encodeURIComponent(publisher)}/${slug
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function resolutionFromSize(size?: string) {
  if (!size) return undefined;
  if (size.includes("_")) return size;
  const aspect = aspectRatioFromSize(size, "480_16_9", "480_9_16");
  return aspect;
}

function parseBody(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function providerErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  if (
    record.error &&
    typeof record.error === "object" &&
    typeof (record.error as Record<string, unknown>).message === "string"
  ) {
    return (record.error as Record<string, string>).message;
  }
  return null;
}

function mapToNvidiaCosmosRequest(
  input: Extract<
    GenerateAssetRequest,
    { provider: "nvidia_api_catalog"; kind: "video" }
  >,
  prompt: string,
  imageDataUri?: string
): NvidiaCosmosRequestBody {
  return {
    prompt,
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    ...(imageDataUri ? { image: imageDataUri } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.resolution || input.size
      ? { resolution: input.resolution || resolutionFromSize(input.size) }
      : {}),
    ...(input.frameCount !== undefined
      ? { num_output_frames: input.frameCount }
      : {}),
    ...(input.fps !== undefined ? { fps: input.fps } : {}),
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    ...(input.guidanceScale !== undefined
      ? { guidance_scale: input.guidanceScale }
      : {}),
  };
}

async function generateNvidiaCosmosVideo(
  input: Extract<
    GenerateAssetRequest,
    { provider: "nvidia_api_catalog"; kind: "video" }
  >
): Promise<GeneratedAssetResult> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY is not set for the NVIDIA API Catalog provider."
    );
  }

  const prompt = requirePrompt(input.prompt);
  const model = nvidiaModel(input.model);
  const referencePath = input.referencePaths?.[0];
  const imageDataUri = referencePath ? await readAsDataUri(referencePath) : undefined;
  const response = await fetch(endpointUrl(nvidiaBaseUrl(), model), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(mapToNvidiaCosmosRequest(input, prompt, imageDataUri)),
  });

  const body = parseBody(await response.text()) as NvidiaCosmosResponse;
  if (!response.ok) {
    throw new Error(
      `NVIDIA Cosmos request failed (${response.status}): ${
        providerErrorMessage(body) || JSON.stringify(body).slice(0, 500)
      }`
    );
  }
  if (!body.b64_video) {
    throw new Error("NVIDIA Cosmos response did not include b64_video.");
  }

  return {
    kind: "video",
    bytes: Buffer.from(stripDataUriPrefix(body.b64_video), "base64"),
    extension: "mp4",
    mimeType: "video/mp4",
    provider: "nvidia_api_catalog",
    model,
    prompt,
    durationSec: input.seconds,
    costUsd: estimateCostUsd({
      provider: "nvidia_api_catalog",
      kind: "video",
      model,
      durationSec: input.seconds,
    }),
    providerSettings: characterProviderSettings(input),
  };
}

function stripDataUriPrefix(value: string) {
  const marker = ";base64,";
  const index = value.indexOf(marker);
  return index === -1 ? value : value.slice(index + marker.length);
}

export const nvidiaCosmosProvider: GenerativeProvider = {
  name: "nvidia_api_catalog",
  async generateAsset(input) {
    if (input.provider !== "nvidia_api_catalog" || input.kind !== "video") {
      throw new Error(
        "NVIDIA API Catalog provider currently supports video generation only."
      );
    }
    return generateNvidiaCosmosVideo(input);
  },
};
