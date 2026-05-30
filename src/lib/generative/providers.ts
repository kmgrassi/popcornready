import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { GoogleGenAI, type Image, type Video } from "@google/genai";
import {
  GenerateAssetRequest,
  GeneratedAssetResult,
  GenerativeProvider,
  GenerativeProviderName,
} from "./types";
import { createElevenLabsAudio } from "./audio";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GEMINI_DEFAULT_VIDEO_MODEL = "veo-3.1-generate-preview";

function requirePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("Prompt is required.");
  return trimmed;
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".png") return "image/png";
  if (ext === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

async function readAsBlob(filePath: string): Promise<Blob> {
  const bytes = await fs.readFile(filePath);
  return new Blob([new Uint8Array(bytes)], { type: mimeForPath(filePath) });
}

async function readAsGeminiImage(filePath: string): Promise<Image> {
  const bytes = await fs.readFile(filePath);
  return {
    imageBytes: Buffer.from(bytes).toString("base64"),
    mimeType: mimeForPath(filePath),
  };
}

function geminiAspectRatio(size?: string): string {
  if (!size) return "16:9";
  const [width, height] = size.split("x").map((part) => Number(part));
  if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) {
    return "16:9";
  }
  return width / height < 1 ? "9:16" : "16:9";
}

function characterProviderSettings(input: GenerateAssetRequest) {
  if (!input.characterContext) return undefined;
  return {
    references: input.characterContext.references.map(
      ({ reference }) => reference.id
    ),
    mode: input.characterContext.consistencyMode,
    durationSec: input.seconds,
    aspectRatio: input.size,
    promptInvariantVersion: input.characterContext.promptInvariantVersion,
  };
}

async function openaiFetch(
  pathName: string,
  init: RequestInit
): Promise<Response> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set for the OpenAI provider.");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);

  const res = await fetch(`${OPENAI_BASE_URL}${pathName}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res;
}

async function generateOpenAIImage(
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  const prompt = requirePrompt(input.prompt);
  const model = input.model || "gpt-image-1.5";
  const referencePaths = input.referencePaths || [];

  if (referencePaths.length > 0) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    if (input.size) form.set("size", input.size);
    if (input.quality) form.set("quality", input.quality);
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
    return {
      kind: "image",
      bytes: Buffer.from(b64, "base64"),
      extension: "png",
      mimeType: "image/png",
      provider: "openai",
      model,
      prompt,
      providerSettings: characterProviderSettings(input),
    };
  }

  const res = await openaiFetch("/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      ...(input.size ? { size: input.size } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
    }),
  });
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image generation returned no image data.");
  return {
    kind: "image",
    bytes: Buffer.from(b64, "base64"),
    extension: "png",
    mimeType: "image/png",
    provider: "openai",
    model,
    prompt,
    providerSettings: characterProviderSettings(input),
  };
}

async function generateOpenAIVideo(
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  const prompt = requirePrompt(input.prompt);
  const model = input.model || "sora-2";
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", input.size || "1280x720");
  form.set("seconds", String(input.seconds || 8));

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
  let video = await createRes.json();
  const id = video?.id;
  if (!id) throw new Error("OpenAI video generation returned no job id.");

  const deadline = Date.now() + 8 * 60 * 1000;
  while (
    (video.status === "queued" || video.status === "in_progress") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const statusRes = await openaiFetch(`/videos/${id}`, { method: "GET" });
    video = await statusRes.json();
  }

  if (video.status !== "completed") {
    throw new Error(`OpenAI video generation did not complete: ${video.status}`);
  }

  const contentRes = await openaiFetch(`/videos/${id}/content`, {
    method: "GET",
  });
  const bytes = Buffer.from(await contentRes.arrayBuffer());
  return {
    kind: "video",
    bytes,
    extension: "mp4",
    mimeType: "video/mp4",
    provider: "openai",
    model,
    prompt,
    providerSettings: characterProviderSettings(input),
  };
}

const openAIProvider: GenerativeProvider = {
  name: "openai",
  async generateAsset(input) {
    if (input.kind === "image") return generateOpenAIImage(input);
    if (input.kind === "video") return generateOpenAIVideo(input);
    throw new Error("OpenAI provider currently supports image and video generation only.");
  },
};

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
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set for the Gemini provider.");
  }

  const prompt = requirePrompt(input.prompt);
  const model = input.model || GEMINI_DEFAULT_VIDEO_MODEL;
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
      aspectRatio: geminiAspectRatio(input.size),
      durationSeconds: input.seconds || 8,
      numberOfVideos: 1,
    },
  });

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
    providerSettings: characterProviderSettings(input),
  };
}

const geminiProvider: GenerativeProvider = {
  name: "gemini",
  async generateAsset(input) {
    if (input.kind !== "video") {
      throw new Error("Gemini provider currently supports video generation only.");
    }
    return generateGeminiVideo(input);
  },
};

const elevenLabsProvider: GenerativeProvider = {
  name: "elevenlabs",
  async generateAsset(input) {
    if (input.kind !== "audio") {
      throw new Error("ElevenLabs provider currently supports audio generation only.");
    }
    return createElevenLabsAudio(input);
  },
};

function unsupportedProvider(name: GenerativeProviderName): GenerativeProvider {
  return {
    name,
    async generateAsset() {
      throw new Error(
        `${name} provider is registered but not implemented in this first pass.`
      );
    },
  };
}

// Build a valid silent PCM WAV so consumers (and audio-duration measurement)
// see real, parseable framing for the requested length.
function buildSilentWav(seconds: number, sampleRate = 8000): Buffer {
  const numSamples = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const mockProvider: GenerativeProvider = {
  name: "mock",
  async generateAsset(input) {
    const prompt = requirePrompt(input.prompt);
    const characterSummary = input.characterContext
      ? [
          `Characters: ${input.characterContext.profiles
            .map((profile) => profile.id)
            .join(", ")}`,
          `References: ${input.characterContext.references
            .map(({ reference }) => reference.id)
            .join(", ")}`,
          `Mode: ${input.characterContext.consistencyMode}`,
          `Invariant: ${input.characterContext.promptInvariantVersion}`,
        ].join(" | ")
      : "Characters: none";

    if (input.kind === "audio") {
      return {
        kind: "audio",
        bytes: buildSilentWav(input.seconds || 8),
        extension: "wav",
        mimeType: "audio/wav",
        provider: "mock",
        model: "mock-wav",
        prompt,
        providerSettings: characterProviderSettings(input),
      };
    }

    if (input.kind === "video") {
      return {
        kind: "video",
        bytes: Buffer.from(`mock-video:${prompt} | ${characterSummary}`),
        extension: "mp4",
        mimeType: "video/mp4",
        provider: "mock",
        model: "mock-mp4",
        prompt,
        providerSettings: characterProviderSettings(input),
      };
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="100%" height="100%" fill="#111827"/><text x="64" y="120" fill="#f9fafb" font-size="48" font-family="Arial">Generated placeholder</text><text x="64" y="200" fill="#cbd5e1" font-size="28" font-family="Arial">${prompt
      .replace(/[<>&]/g, "")
      .slice(0, 90)}</text><text x="64" y="260" fill="#94a3b8" font-size="22" font-family="Arial">${characterSummary
      .replace(/[<>&]/g, "")
      .slice(0, 120)}</text></svg>`;
    return {
      kind: "image",
      bytes: Buffer.from(svg),
      extension: "svg",
      mimeType: "image/svg+xml",
      provider: "mock",
      model: "mock-svg",
      prompt,
      providerSettings: characterProviderSettings(input),
    };
  },
};

export function providerFor(name: string): GenerativeProvider {
  switch (name.toLowerCase()) {
    case "openai":
      return openAIProvider;
    case "gemini":
      return geminiProvider;
    case "elevenlabs":
      return elevenLabsProvider;
    case "nanobanano":
    case "nano-banano":
    case "nano_banano":
      return unsupportedProvider("nanobanano");
    case "mock":
      return mockProvider;
    default:
      throw new Error(`Unknown generative provider: ${name}`);
  }
}
