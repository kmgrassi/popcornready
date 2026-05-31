import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { providerFor } from "@/lib/generative/providers";
import { Clip, Timeline, TimelineSegment, dims, timelineDurationSec } from "@/lib/types";
import { POPCORN_READY_STORY_SHOTS } from "../presets";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

const GENERATED_DIR = path.join(process.cwd(), "public", "debug", "openai-videos");
const DEBUG_EXPORT_DIR = path.join(process.cwd(), "public", "debug", "exports");

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function buildTimeline(segments: TimelineSegment[]): Timeline {
  return {
    aspectRatio: "9:16",
    fps: 30,
    segments,
  };
}

function parseDebugProvider(value: unknown): "openai" | "gemini" {
  const raw = String(value || "gemini").toLowerCase();
  if (raw === "openai") return "openai";
  if (raw === "gemini") return "gemini";
  throw new Error("Debug story video generation supports only provider=openai or provider=gemini.");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const size = body.size ? String(body.size) : "720x1280";
    const model = body.model ? String(body.model) : undefined;
    const render = body.render !== false;
    const provider = parseDebugProvider(body.provider);
    const providerAdapter = providerFor(provider);

    const clips: Clip[] = [];
    const timelineSegments: TimelineSegment[] = [];
    const requests = [];

    for (let index = 0; index < POPCORN_READY_STORY_SHOTS.length; index += 1) {
      const shot = POPCORN_READY_STORY_SHOTS[index];
      const request =
        provider === "openai"
          ? {
              provider: "openai" as const,
              kind: "video" as const,
              prompt: shot.prompt,
              size,
              model,
              seconds: shot.durationSec,
            }
          : {
              provider: "gemini" as const,
              kind: "video" as const,
              prompt: shot.prompt,
              size,
              model,
              seconds: shot.durationSec,
            };
      requests.push(request);

      const result = await providerAdapter.generateAsset(request);
      await fs.mkdir(GENERATED_DIR, { recursive: true });
      const filename = `${newId(`${provider}_story_${shot.key}`)}.${result.extension}`;
      const filePath = path.join(GENERATED_DIR, filename);
      await fs.writeFile(filePath, result.bytes);
      const url = `/debug/openai-videos/${filename}`;
      const id = newId("dbgseg");
      const clip: Clip = {
        id,
        filename,
        url,
        kind: result.kind,
        durationSec: shot.durationSec,
        description: shot.key,
        source: "generated",
        generatedBy: {
          provider: result.provider,
          model: result.model,
          prompt: shot.prompt,
          providerPrompt: result.prompt,
        },
      };
      const segment: TimelineSegment = {
        id: newId("seg"),
        clipId: clip.id,
        sourceInSec: 0,
        sourceOutSec: shot.durationSec,
        role: shot.key,
        reason: shot.prompt,
      };

      clips.push(clip);
      timelineSegments.push(segment);
    }

    const timeline = buildTimeline(timelineSegments);
    const totalDurationSec = timelineDurationSec(timeline);

    let exportedUrl: string | null = null;
    let exportError: string | null = null;

    if (render) {
      try {
        const entry = path.join(process.cwd(), "src", "remotion", "index.ts");
        const { bundle } = await import("@remotion/bundler");
        const { selectComposition, renderMedia, ensureBrowser } = await import(
          "@remotion/renderer"
        );

        const origin = new URL(req.url).origin;
        const serveUrl = await bundle({ entryPoint: entry });
        await ensureBrowser();

        const { width, height } = dims(timeline.aspectRatio);
        const durationInFrames = Math.max(1, Math.round(totalDurationSec * timeline.fps));
        const composition = await selectComposition({
          serveUrl,
          id: "main",
          inputProps: {
            timeline,
            clips,
            baseUrl: origin,
          },
        });

        await fs.mkdir(DEBUG_EXPORT_DIR, { recursive: true });
        const exportName = `openai-story-${Date.now()}.mp4`;
        const exportPath = path.join(DEBUG_EXPORT_DIR, exportName);
        await renderMedia({
          composition: {
            ...composition,
            durationInFrames,
            fps: timeline.fps,
            width,
            height,
          },
          serveUrl,
          codec: "h264",
          outputLocation: exportPath,
          inputProps: {
            timeline,
            clips,
            baseUrl: origin,
          },
          muted: true,
        });
        exportedUrl = `/debug/exports/${exportName}`;
      } catch (error: any) {
        exportError = error?.message || "Video edit render failed";
      }
    }

    return NextResponse.json({
      status: render ? "ok" : "generated",
      rendered: render,
      totalDurationSec,
      shots: POPCORN_READY_STORY_SHOTS.length,
      clips,
      timeline,
      exportedUrl,
      exportError,
      requests,
      message: exportedUrl
        ? "Storyboard prompts were generated and stitched into a single video."
        : render
        ? "Clip generation succeeded; render failed for stitched edit."
        : "Clip generation succeeded; rendering was disabled.",
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Debug story montage generation failed" },
      { status: 500 }
    );
  }
}
