import { NextRequest, NextResponse } from "next/server";
import { providerFor } from "@/lib/generative/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

function numberField(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const provider = providerFor("nvidia_api_catalog");
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      return NextResponse.json(
        { error: { code: "invalid_request", message: "prompt is required" } },
        { status: 400 }
      );
    }

    const video = await provider.generateAsset({
      provider: "nvidia_api_catalog",
      kind: "video",
      prompt,
      model: body.model ? String(body.model) : undefined,
      size: body.size ? String(body.size) : undefined,
      seconds: numberField(body.seconds),
      seed: numberField(body.seed),
      frameCount: numberField(body.frameCount),
      fps: numberField(body.fps),
      steps: numberField(body.steps),
      guidanceScale: numberField(body.guidanceScale),
      negativePrompt: body.negativePrompt
        ? String(body.negativePrompt)
        : undefined,
      resolution: body.resolution ? String(body.resolution) : undefined,
    });

    return NextResponse.json({
      video: {
        provider: video.provider,
        model: video.model,
        mimeType: video.mimeType,
        b64Video: video.bytes.toString("base64"),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message.includes("not set") || message.includes("prompt is required")
        ? 400
        : message.includes("failed (4")
          ? 400
          : 502;
    return NextResponse.json(
      { error: { code: "video_generation_failed", message } },
      { status }
    );
  }
}
