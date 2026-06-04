import type {
  GeneratedAssetResult,
  GenerativeProvider,
  GenerativeProviderName,
} from "@popcorn/shared/generative/types";
import { estimateCostUsd } from "../pricing";
import { characterProviderSettings, requirePrompt } from "./shared";

function buildSilentWav(seconds: number, sampleRate = 8000): Buffer {
  const numSamples = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

export function unsupportedProvider(name: GenerativeProviderName): GenerativeProvider {
  return {
    name,
    async generateAsset() {
      throw new Error(
        `${name} provider is registered but not implemented in this first pass.`
      );
    },
  };
}

export const mockProvider: GenerativeProvider = {
  name: "mock",
  async generateAsset(input): Promise<GeneratedAssetResult> {
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
        costUsd: estimateCostUsd({
          provider: "mock",
          kind: "audio",
          durationSec: input.seconds || 8,
        }),
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
        costUsd: estimateCostUsd({
          provider: "mock",
          kind: "video",
          durationSec: input.seconds,
        }),
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
      costUsd: estimateCostUsd({ provider: "mock", kind: "image" }),
      providerSettings: characterProviderSettings(input),
    };
  },
};
