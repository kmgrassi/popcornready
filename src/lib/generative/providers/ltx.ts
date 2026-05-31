import type {
  GenerateAssetRequest,
  GeneratedAssetResult,
  GenerativeProvider,
} from "../types";
import { estimateCostUsd } from "../pricing";
import {
  aspectRatioFromSize,
  authedFetch,
  characterProviderSettings,
  readAsDataUri,
  requirePrompt,
} from "./shared";

const LTX_BASE_URL = "https://api.ltx.video/v1";
const LTX_DEFAULT_VIDEO_MODEL = "ltx-2-3-fast";

function ltxResolution(size?: string): string {
  return aspectRatioFromSize(size, "1920x1080", "1080x1920");
}

function normalizeLtxVideoSeconds(value?: number, model = LTX_DEFAULT_VIDEO_MODEL): number {
  const candidate = Math.round(Number(value));
  const durations = model.includes("fast")
    ? [6, 8, 10, 12, 14, 16, 18, 20]
    : [6, 8, 10];
  if (!Number.isFinite(candidate)) return 8;
  return durations.reduce((best, current) =>
    Math.abs(current - candidate) < Math.abs(best - candidate) ? current : best
  );
}

function ltxFetch(pathName: string, init: RequestInit): Promise<Response> {
  return authedFetch({
    baseUrl: LTX_BASE_URL,
    pathName,
    init,
    apiKey: process.env.LTX_API_KEY,
    missingKeyMessage: "LTX_API_KEY is not set for the LTX provider.",
    errorPrefix: "LTX",
  });
}

async function generateLtxVideo(
  input: Extract<GenerateAssetRequest, { provider: "ltx"; kind: "video" }>
): Promise<GeneratedAssetResult> {
  const prompt = requirePrompt(input.prompt);
  const model = input.model || LTX_DEFAULT_VIDEO_MODEL;
  const duration = normalizeLtxVideoSeconds(input.seconds, model);
  const firstReference = input.referencePaths?.[0];
  const endpoint = firstReference ? "/image-to-video" : "/text-to-video";
  const body = {
    prompt,
    model,
    duration,
    resolution: ltxResolution(input.size),
    fps: 24,
    generate_audio: false,
    ...(firstReference ? { image_uri: await readAsDataUri(firstReference) } : {}),
  };

  const res = await ltxFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    kind: "video",
    bytes: Buffer.from(await res.arrayBuffer()),
    extension: "mp4",
    mimeType: res.headers.get("Content-Type") || "video/mp4",
    provider: "ltx",
    model,
    prompt,
    costUsd: estimateCostUsd({
      provider: "ltx",
      kind: "video",
      model,
      durationSec: duration,
    }),
    providerSettings: characterProviderSettings(input),
  };
}

export const ltxProvider: GenerativeProvider = {
  name: "ltx",
  async generateAsset(input) {
    if (input.provider !== "ltx" || input.kind !== "video") {
      throw new Error("LTX provider currently supports video generation only.");
    }
    return generateLtxVideo(input);
  },
};
