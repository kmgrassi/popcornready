import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { saveProject } from "@/lib/store";
import { critique, planEdit } from "@/lib/agent";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import { providerFor } from "@/lib/generative/providers";
import {
  AspectRatio,
  Beat,
  Clip,
  Project,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "@/lib/types";
import { mergeStoryContext } from "@/lib/story-context";
import { videoQualityContextForPrompt } from "@/lib/video-quality-context";

export const dynamic = "force-dynamic";
// Per-beat video generation is slow. Clips are generated in parallel so the
// wall-clock cost is ~the slowest single clip, but give the request headroom.
export const maxDuration = 800;

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");

type OneShotMode = "video" | "image";

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

// Operator kill switch. Defaults ON so early visitors get a real generated
// video; set ONESHOT_VIDEO=off to fall back to cheap still-frame mode under
// heavy traffic. Read per-request (the route is dynamic) so flipping the env
// + restarting the server is enough to toggle it.
function oneShotVideoEnabled(): boolean {
  const v = (process.env.ONESHOT_VIDEO ?? "on").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(v);
}

// Resolve the generation mode and provider from the kill switch, available
// provider keys, and any explicit request override. Always degrades to a mode
// that can actually run, so the one-shot never hard-fails on configuration.
function resolveMode(body: any): { mode: OneShotMode; provider: string } {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const requested =
    body.mode === "image" || body.mode === "video"
      ? (body.mode as OneShotMode)
      : undefined;
  const wantVideo = requested ? requested === "video" : oneShotVideoEnabled();

  if (wantVideo) {
    if (body.provider === "gemini" && hasGemini) {
      return { mode: "video", provider: "gemini" };
    }
    if (hasOpenAI) return { mode: "video", provider: "openai" };
    if (hasGemini) return { mode: "video", provider: "gemini" };
    // No video-capable key — fall through to image mode below.
  }

  const imageProvider =
    body.provider && body.provider !== "gemini"
      ? String(body.provider)
      : hasOpenAI
        ? "openai"
        : "mock";
  return { mode: "image", provider: imageProvider };
}

function imageSizeForAspect(ar: AspectRatio): string {
  if (ar === "16:9") return "1536x1024";
  if (ar === "1:1") return "1024x1024";
  return "1024x1536"; // 9:16
}

function videoSizeForAspect(ar: AspectRatio): string {
  if (ar === "16:9") return "1280x720";
  if (ar === "1:1") return "1024x1024";
  return "720x1280"; // 9:16
}

function clampSeconds(durationSec: number): number {
  const s = Math.round(Number(durationSec) || 6);
  return Math.min(8, Math.max(4, s));
}

function beatPrompt(
  goal: string,
  beat: Beat,
  style: string,
  ar: AspectRatio,
  mode: OneShotMode
): string {
  const medium =
    mode === "video"
      ? "cinematic live-action video clip with natural motion and camera movement"
      : "cinematic still frame";
  return [
    `${style} ${medium} for a ${ar} short-form video.`,
    `Beat: ${beat.name} — ${beat.intent}.`,
    `Overall concept: ${goal}.`,
    `Production quality guidance: ${videoQualityContextForPrompt()}`,
    `Make the shot feel designed, not accidental: strong visual hierarchy, controlled lighting, subject-background separation, cohesive tone, and no on-screen text.`,
  ].join(" ");
}

async function generateBeatClip(input: {
  mode: OneShotMode;
  provider: string;
  prompt: string;
  description: string;
  size: string;
  displaySec: number;
  seconds?: number;
}): Promise<Clip> {
  const kind = input.mode === "video" ? "video" : "image";
  const provider = providerFor(input.provider);
  const result = await provider.generateAsset({
    provider: provider.name,
    kind,
    prompt: input.prompt,
    size: input.size,
    ...(kind === "video" ? { seconds: input.seconds } : {}),
  });
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const id = newId(kind === "video" ? "vid" : "img");
  const filename = `${id}.${result.extension}`;
  await fs.writeFile(path.join(GENERATED_DIR, filename), result.bytes);
  return {
    id,
    filename,
    url: `/generated/${filename}`,
    kind: result.kind,
    durationSec: input.displaySec,
    description: input.description,
    source: "generated",
    generatedBy: {
      provider: result.provider,
      model: result.model,
      prompt: result.prompt,
    },
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const goal = String(body.goal || "").trim();
    const targetLengthSec = Number(body.targetLengthSec) || 30;
    const style = String(body.style || "fast-paced social ad");
    const aspectRatio = (body.aspectRatio || "9:16") as AspectRatio;
    const storyContext = mergeStoryContext(body.storyContext as StoryContext);
    const { mode, provider } = resolveMode(body);

    if (!goal) {
      return NextResponse.json(
        { error: "Describe the video you want to create." },
        { status: 400 }
      );
    }

    // 1. Plan: goal -> beats
    const plan = await planEdit({
      goal,
      targetLengthSec,
      style,
      aspectRatio,
      storyContext,
    });

    if (!plan.beats || plan.beats.length === 0) {
      return NextResponse.json(
        { error: "The planner returned no beats for this prompt." },
        { status: 502 }
      );
    }

    // 2. Generate a visual per beat from scratch (no uploads required). In
    // video mode each beat becomes a short generated clip so the assembled
    // result is a real moving video; in image mode each beat is a still frame.
    const imageSize = imageSizeForAspect(aspectRatio);
    const videoSize = videoSizeForAspect(aspectRatio);
    const clips = await Promise.all(
      plan.beats.map((beat) => {
        if (mode === "video") {
          const seconds = clampSeconds(beat.durationSec);
          return generateBeatClip({
            mode,
            provider,
            prompt: beatPrompt(goal, beat, style, aspectRatio, mode),
            description: `${beat.name}: ${beat.intent}`,
            size: videoSize,
            displaySec: seconds,
            seconds,
          });
        }
        return generateBeatClip({
          mode,
          provider,
          prompt: beatPrompt(goal, beat, style, aspectRatio, mode),
          description: `${beat.name}: ${beat.intent}`,
          size: imageSize,
          displaySec: Math.max(1.5, Number(beat.durationSec) || 4),
        });
      })
    );

    // 3. Assemble a beat-by-beat timeline from the generated clips.
    const segments: TimelineSegment[] = plan.beats.map((beat, i) => ({
      id: newId("seg"),
      clipId: clips[i].id,
      sourceInSec: 0,
      sourceOutSec: clips[i].durationSec,
      role: beat.name,
      reason: beat.intent,
    }));
    let timeline: Timeline = sanitizeTimeline(
      { aspectRatio, fps: 30, segments },
      clips
    );

    // 4. Critique once and apply patches — but never let it empty the cut.
    const { report, patches } = await critique({
      plan,
      timeline,
      clips,
      storyContext,
    });
    const patched = applyPatches(timeline, patches, clips);
    if (patched.segments.length > 0) timeline = patched;

    const project: Project = {
      id: "default",
      goal,
      storyContext,
      plan,
      timeline,
      clips,
      characterProfiles: [],
      characterReferences: [],
      critic: report,
      chat: [],
      updatedAt: new Date().toISOString(),
    };
    await saveProject(project);

    return NextResponse.json({
      project,
      mode,
      provider,
      generatedClips: clips.length,
      appliedPatches: patches.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "One-shot generation failed" },
      { status: 500 }
    );
  }
}
