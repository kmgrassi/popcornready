import { AspectRatio } from "@/lib/types";
import { OpenAIVideoSeconds, normalizeOpenAIVideoSeconds } from "@/lib/generative/types";

export type VideoProvider = "openai" | "gemini" | "runway" | "ltx";

export function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

export function resolveVideoProviders(body: any): {
  primary: VideoProvider;
  fallback?: VideoProvider;
} {
  const hasOpenAI = Boolean((process.env.OPENAI_API_KEY || "").trim());
  const hasGemini = Boolean((process.env.GEMINI_API_KEY || "").trim());
  const hasRunway = Boolean(
    (process.env.RUNWAYML_API_SECRET || process.env.RUNWAY_API_KEY || "").trim()
  );
  const hasLtx = Boolean((process.env.LTX_API_KEY || "").trim());
  const requestedProvider =
    typeof body.provider === "string"
      ? body.provider.toLowerCase().trim()
      : undefined;

  if (requestedProvider === "mock") {
    throw new Error(
      "Mock provider is disabled for one-shot. Remove provider='mock' to use real video generation."
    );
  }
  if (requestedProvider === "gemini") {
    if (!hasGemini) {
      throw new Error(
        "One-shot video requested provider='gemini', but GEMINI_API_KEY is not configured."
      );
    }
    return { primary: "gemini" };
  }
  if (requestedProvider === "runway" || requestedProvider === "runwayml") {
    if (!hasRunway) {
      throw new Error(
        "One-shot video requested provider='runway', but RUNWAYML_API_SECRET is not configured."
      );
    }
    return { primary: "runway" };
  }
  if (
    requestedProvider === "ltx" ||
    requestedProvider === "ltxvideo" ||
    requestedProvider === "ltx-video"
  ) {
    if (!hasLtx) {
      throw new Error(
        "One-shot video requested provider='ltx', but LTX_API_KEY is not configured."
      );
    }
    return { primary: "ltx" };
  }
  if (
    requestedProvider &&
    requestedProvider !== "openai" &&
    requestedProvider !== "gemini" &&
    requestedProvider !== "runway" &&
    requestedProvider !== "runwayml" &&
    requestedProvider !== "ltx" &&
    requestedProvider !== "ltxvideo" &&
    requestedProvider !== "ltx-video"
  ) {
    throw new Error(
      `One-shot video currently supports openai, gemini, runway, or ltx providers. Received: ${requestedProvider}`
    );
  }
  if (requestedProvider === "openai") {
    if (!hasOpenAI) {
      throw new Error(
        "One-shot video requested provider='openai', but OPENAI_API_KEY is not configured."
      );
    }
    return { primary: "openai" };
  }
  if (hasGemini) {
    return { primary: "gemini", fallback: hasOpenAI ? "openai" : undefined };
  }
  if (hasOpenAI) return { primary: "openai" };
  if (hasRunway) return { primary: "runway" };
  if (hasLtx) return { primary: "ltx" };
  throw new Error(
    "No video-capable provider is configured for one-shot. Set GEMINI_API_KEY, OPENAI_API_KEY, RUNWAYML_API_SECRET, or LTX_API_KEY."
  );
}

export function parseShowCaptions(value: unknown): boolean {
  return value === true || value === "true";
}

export function audioRequested(body: any, goal: string): boolean {
  if (
    body.includeAudio === false ||
    body.generateAudio === false ||
    body.audio === false ||
    body.audioMode === "none"
  ) {
    return false;
  }
  return !/\b(no audio|no music|silent video|without audio|without music)\b/i.test(
    goal
  );
}

export function videoSizeForAspect(ar: AspectRatio): string {
  if (ar === "16:9") return "1280x720";
  if (ar === "1:1") return "1280x720";
  return "720x1280"; // 9:16
}

export function clampSeconds(durationSec: number): OpenAIVideoSeconds {
  return normalizeOpenAIVideoSeconds(durationSec);
}
