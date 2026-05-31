import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { providerFor } from "@/lib/generative/providers";
import {
  normalizeOpenAIVideoSeconds,
  OpenAIVideoSeconds,
} from "@/lib/generative/types";
import {
  DEFAULT_SINGLE_OPENAI_VIDEO,
} from "../presets";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GENERATED_DIR = path.join(process.cwd(), "public", "debug", "openai-videos");

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function resolveSeconds(value: unknown, fallback: OpenAIVideoSeconds = 8): OpenAIVideoSeconds {
  if (typeof value !== "number") return fallback;
  return normalizeOpenAIVideoSeconds(value, fallback);
}

function parseDebugProvider(value: unknown): "openai" | "gemini" {
  const raw = String(value || "gemini").toLowerCase();
  if (raw === "openai") return "openai";
  if (raw === "gemini") return "gemini";
  throw new Error("Debug video generation supports only provider=openai or provider=gemini.");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const prompt = String(body.prompt || DEFAULT_SINGLE_OPENAI_VIDEO).trim();
    const size = body.size ? String(body.size) : "1280x720";
    const model = body.model ? String(body.model) : undefined;
    const seconds = resolveSeconds(body.seconds, 8);
    const provider = parseDebugProvider(body.provider);

    if (!prompt) {
      return NextResponse.json(
        { error: "prompt is required for single debug video generation." },
        { status: 400 }
      );
    }

    const providerAdapter = providerFor(provider);
    const requestPayload =
      provider === "openai"
        ? {
            provider: "openai" as const,
            kind: "video" as const,
            prompt,
            size,
            model,
            seconds,
          }
        : {
            provider: "gemini" as const,
            kind: "video" as const,
            prompt,
            size,
            model,
            seconds,
          };

    const result = await providerAdapter.generateAsset(requestPayload);

    await fs.mkdir(GENERATED_DIR, { recursive: true });
    const filename = `${newId("openai_vid")}.${result.extension}`;
    const filePath = path.join(GENERATED_DIR, filename);
    await fs.writeFile(filePath, result.bytes);

    const publicUrl = `/debug/openai-videos/${filename}`;

    return NextResponse.json({
      status: "ok",
      provider: result.provider,
      request: requestPayload,
      clip: {
        provider: result.provider,
        model: result.model,
        prompt: result.prompt,
        filename,
        url: publicUrl,
        durationSec: seconds,
        kind: result.kind,
        extension: result.extension,
        mimeType: result.mimeType,
      },
      message:
        `${providerAdapter.name} video generation returned a real clip. Check clip.url in devtools or your browser.`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Debug single-video generation failed" },
      { status: 500 }
    );
  }
}
