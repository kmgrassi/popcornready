import { promises as fs } from "fs";
import path from "path";
import type { GenerateAssetRequest } from "@popcorn/shared/generative/types";

export function requirePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("Prompt is required.");
  return trimmed;
}

export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".png") return "image/png";
  if (ext === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

export async function readAsBlob(filePath: string): Promise<Blob> {
  const bytes = await fs.readFile(filePath);
  return new Blob([new Uint8Array(bytes)], { type: mimeForPath(filePath) });
}

export async function readAsDataUri(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return `data:${mimeForPath(filePath)};base64,${Buffer.from(bytes).toString(
    "base64"
  )}`;
}

export function characterProviderSettings(input: GenerateAssetRequest) {
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

export async function authedFetch(input: {
  baseUrl: string;
  pathName: string;
  init: RequestInit;
  apiKey: string | undefined;
  missingKeyMessage: string;
  errorPrefix: string;
  headers?: Record<string, string>;
}): Promise<Response> {
  if (!input.apiKey) throw new Error(input.missingKeyMessage);

  const headers = new Headers(input.init.headers);
  headers.set("Authorization", `Bearer ${input.apiKey}`);
  for (const [key, value] of Object.entries(input.headers || {})) {
    headers.set(key, value);
  }

  const res = await fetch(`${input.baseUrl}${input.pathName}`, {
    ...input.init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `${input.errorPrefix} request failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  return res;
}

export function aspectRatioFromSize(
  size: string | undefined,
  landscape: string,
  portrait: string
): string {
  if (!size) return landscape;
  const [width, height] = size.split("x").map((part) => Number(part));
  if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) {
    return landscape;
  }
  return width / height < 1 ? portrait : landscape;
}
