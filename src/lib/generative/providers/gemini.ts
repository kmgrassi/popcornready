import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { GoogleGenAI, type Image, type Video } from "@google/genai";
import type {
  GenerateAssetRequest,
  GeneratedAssetResult,
  GenerativeProvider,
} from "../types";
import { estimateCostUsd } from "../pricing";
import {
  aspectRatioFromSize,
  characterProviderSettings,
  mimeForPath,
  requirePrompt,
} from "./shared";

const GEMINI_DEFAULT_VIDEO_MODEL = "veo-3.1-generate-preview";

async function readAsGeminiImage(filePath: string): Promise<Image> {
  const bytes = await fs.readFile(filePath);
  return {
    imageBytes: Buffer.from(bytes).toString("base64"),
    mimeType: mimeForPath(filePath),
  };
}

function normalizeGeminiVideoSeconds(value?: number): number {
  const candidate = Math.round(Number(value));
  if (!Number.isFinite(candidate)) return 8;
  if (candidate <= 4) return 4;
  if (candidate <= 6) return 6;
  return 8;
}

async function downloadGeminiVideo(ai: GoogleGenAI, video: Video): Promise<Buffer> {
  if (video.videoBytes) return Buffer.from(video.videoBytes, "base64");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-gemini-"));
  const tmpPath = path.join(tmpDir, "generated.mp4");
  try {
    await ai.files.download({ file: video, downloadPath: tmpPath });
    return await fs.readFile(tmpPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function generateGeminiVideo(
  input: Extract<GenerateAssetRequest, { provider: "gemini"; kind: "video" }>
): Promise<GeneratedAssetResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set for the Gemini provider.");
  }

  const prompt = requirePrompt(input.prompt);
  const model = input.model || GEMINI_DEFAULT_VIDEO_MODEL;
  const durationSeconds = normalizeGeminiVideoSeconds(input.seconds);
  const ai = new GoogleGenAI({ apiKey: key });
  const firstReference = input.referencePaths?.[0];
  if (
    input.characterContext &&
    input.characterContext.consistencyMode === "reference_pack" &&
    input.characterContext.references.length > 1
  ) {
    throw new Error(
      "Gemini video generation supports hero_frame or first_frame_video character references, not multi-image reference_pack."
    );
  }

  let operation = await ai.models.generateVideos({
    model,
    prompt,
    ...(firstReference ? { image: await readAsGeminiImage(firstReference) } : {}),
    config: {
      aspectRatio: aspectRatioFromSize(input.size, "16:9", "9:16"),
      durationSeconds,
      numberOfVideos: 1,
    },
  });
  console.info(
    `[gemini] video operation started: ${operation.name || "unknown operation"}`
  );

  const deadline = Date.now() + 12 * 60 * 1000;
  while (!operation.done && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  if (!operation.done) {
    throw new Error("Gemini video generation timed out before completion.");
  }
  if (operation.error) {
    throw new Error(`Gemini video generation failed: ${JSON.stringify(operation.error)}`);
  }

  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error("Gemini video generation returned no video data.");

  return {
    kind: "video",
    bytes: await downloadGeminiVideo(ai, video),
    extension: "mp4",
    mimeType: video.mimeType || "video/mp4",
    provider: "gemini",
    model,
    prompt,
    costUsd: estimateCostUsd({
      provider: "gemini",
      kind: "video",
      model,
      durationSec: durationSeconds,
    }),
    providerSettings: characterProviderSettings(input),
  };
}

export const geminiProvider: GenerativeProvider = {
  name: "gemini",
  async generateAsset(input) {
    if (input.provider !== "gemini" || input.kind !== "video") {
      throw new Error("Gemini provider currently supports video generation only.");
    }
    return generateGeminiVideo(input);
  },
};
