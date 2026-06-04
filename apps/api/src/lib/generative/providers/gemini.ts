import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { GoogleGenAI, type Image, type Video } from "@google/genai";
import type {
  GenerateAssetRequest,
  GeneratedAssetResult,
  GenerativeProvider,
} from "@popcorn/shared/generative/types";
import { estimateCostUsd } from "../pricing";
import {
  aspectRatioFromSize,
  characterProviderSettings,
  mimeForPath,
  requirePrompt,
} from "./shared";

const GEMINI_DEFAULT_VIDEO_MODEL = "veo-3.1-generate-preview";
// "Nano banana" — the only image model that will edit a photorealistic image of
// a minor (OpenAI's image-edit endpoint rejects that), which one-shot stories
// frequently feature. Used to generate per-beat keyframes from the hero image.
const GEMINI_DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

async function readAsGeminiImage(filePath: string): Promise<Image> {
  const bytes = await fs.readFile(filePath);
  return {
    imageBytes: Buffer.from(bytes).toString("base64"),
    mimeType: mimeForPath(filePath),
  };
}

async function generateGeminiImage(
  input: Extract<GenerateAssetRequest, { provider: "gemini"; kind: "image" }>
): Promise<GeneratedAssetResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set for the Gemini provider.");
  }

  const prompt = requirePrompt(input.prompt);
  const model = input.model || GEMINI_DEFAULT_IMAGE_MODEL;
  const ai = new GoogleGenAI({ apiKey: key });

  // Reference images (e.g. the character hero frame) are passed inline so the
  // model can keep the same subject while changing pose/scene per beat.
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const ref of input.referencePaths || []) {
    const bytes = await fs.readFile(ref);
    parts.push({
      inlineData: {
        mimeType: mimeForPath(ref),
        data: Buffer.from(bytes).toString("base64"),
      },
    });
  }

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: parts as never }],
  });
  const outParts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = outParts.find(
    (part) => (part as { inlineData?: { data?: string } }).inlineData?.data
  ) as { inlineData?: { data: string; mimeType?: string } } | undefined;
  if (!imagePart?.inlineData?.data) {
    const text =
      (outParts.find((part) => (part as { text?: string }).text) as { text?: string })?.text || "";
    throw new Error(
      `Gemini image generation returned no image data. ${text.slice(0, 200)}`
    );
  }

  const mimeType = imagePart.inlineData.mimeType || "image/png";
  return {
    kind: "image",
    bytes: Buffer.from(imagePart.inlineData.data, "base64"),
    extension: mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png",
    mimeType,
    provider: "gemini",
    model,
    prompt,
    costUsd: estimateCostUsd({ provider: "gemini", kind: "image", model }),
    providerSettings: characterProviderSettings(input),
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
    if (input.provider !== "gemini") {
      throw new Error("Gemini provider received a non-gemini request.");
    }
    if (input.kind === "video") return generateGeminiVideo(input);
    if (input.kind === "image") return generateGeminiImage(input);
    throw new Error("Gemini provider supports video and image generation only.");
  },
};
