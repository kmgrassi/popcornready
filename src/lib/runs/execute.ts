// Execute a generation run end-to-end and emit stage progress as it goes.
//
// This is the asynchronous twin of /api/oneshot: the same planner -> per-beat
// generation -> assembly -> critique flow, but each step writes progress into
// the run store so the polling UI can render a live stage rail. The final
// project is saved through the existing project store so the editor surface
// keeps working unchanged.

import { promises as fs } from "fs";
import path from "path";
import { critique, planEdit } from "@/lib/agent";
import { providerFor } from "@/lib/generative/providers";
import { GenerativeProviderName } from "@/lib/generative/types";
import { saveProject } from "@/lib/store";
import { mergeStoryContext } from "@/lib/story-context";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import {
  AspectRatio,
  Beat,
  Clip,
  Project,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "@/lib/types";
import { videoQualityContextForPrompt } from "@/lib/video-quality-context";
import {
  completeStage,
  failStage,
  markRunFailed,
  markRunRunning,
  markRunSucceeded,
  setStageMessage,
  startStage,
} from "./store";
import { GenerationRun } from "./types";

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");

type Mode = "video" | "image";
type VisualProvider = Extract<GenerativeProviderName, "openai" | "gemini" | "mock">;

function newAssetId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function oneShotVideoEnabled(): boolean {
  const v = (process.env.ONESHOT_VIDEO ?? "on").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(v);
}

function resolveMode(): { mode: Mode; provider: VisualProvider } {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  if (oneShotVideoEnabled()) {
    if (hasOpenAI) return { mode: "video", provider: "openai" };
    if (hasGemini) return { mode: "video", provider: "gemini" };
  }
  const imageProvider = hasOpenAI ? "openai" : "mock";
  return { mode: "image", provider: imageProvider };
}

function imageSizeForAspect(ar: AspectRatio): string {
  if (ar === "16:9") return "1536x1024";
  if (ar === "1:1") return "1024x1024";
  return "1024x1536";
}

function videoSizeForAspect(ar: AspectRatio): string {
  if (ar === "16:9") return "1280x720";
  if (ar === "1:1") return "1024x1024";
  return "720x1280";
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
  mode: Mode
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
  mode: Mode;
  provider: VisualProvider;
  prompt: string;
  description: string;
  size: string;
  displaySec: number;
  seconds?: number;
}): Promise<Clip> {
  const kind = input.mode === "video" ? "video" : "image";
  const provider = providerFor(input.provider);
  const baseRequest = {
    prompt: input.prompt,
    size: input.size,
    ...(kind === "video" ? { seconds: input.seconds } : {}),
  };
  const result =
    input.provider === "gemini"
      ? await provider.generateAsset({
          provider: "gemini",
          kind: "video",
          ...baseRequest,
        })
      : input.provider === "openai"
        ? await provider.generateAsset({
            provider: "openai",
            kind,
            ...baseRequest,
          })
        : await provider.generateAsset({
            provider: "mock",
            kind,
            ...baseRequest,
          });
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const id = newAssetId(kind === "video" ? "vid" : "img");
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

function describeError(err: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const retryable =
    lower.includes("timeout") ||
    lower.includes("rate limit") ||
    lower.includes("temporarily");
  return { code: "generation_failed", message, retryable };
}

export async function executeRun(run: GenerationRun): Promise<void> {
  const { runId } = run;
  const targetLengthSec = Number(run.inputs.targetLengthSec) || 30;
  const style = run.inputs.style || "fast-paced social ad";
  const aspectRatio = (run.inputs.aspectRatio || "9:16") as AspectRatio;
  const goal = run.inputs.goal.trim();
  const storyContext = mergeStoryContext(
    (run.inputs.storyContext as StoryContext | undefined) || undefined
  );

  try {
    await markRunRunning(runId);

    if (!goal) {
      const error = {
        code: "validation_failed",
        message: "Describe the video you want to create.",
        retryable: false,
      };
      await failStage(runId, "brief_intake", error);
      await markRunFailed(runId, error);
      return;
    }

    // brief_intake: the inputs are already in place; just record completion.
    await startStage(runId, "brief_intake", "Preparing your video brief…");
    await completeStage(runId, "brief_intake", "Brief ready.");

    // creative_plan
    await startStage(
      runId,
      "creative_plan",
      `Planning a ${targetLengthSec}-second ${style}…`
    );
    let plan;
    try {
      plan = await planEdit({
        goal,
        targetLengthSec,
        style,
        aspectRatio,
        storyContext,
      });
    } catch (err) {
      const error = describeError(err);
      await failStage(runId, "creative_plan", error);
      await markRunFailed(runId, error);
      return;
    }
    if (!plan.beats || plan.beats.length === 0) {
      const error = {
        code: "planner_empty",
        message: "The planner returned no beats for this prompt.",
        retryable: true,
      };
      await failStage(runId, "creative_plan", error);
      await markRunFailed(runId, error);
      return;
    }
    await completeStage(
      runId,
      "creative_plan",
      `Planned ${plan.beats.length} beats.`
    );

    // asset_generation
    const { mode, provider } = resolveMode();
    const imageSize = imageSizeForAspect(aspectRatio);
    const videoSize = videoSizeForAspect(aspectRatio);
    await startStage(
      runId,
      "asset_generation",
      `Generating ${plan.beats.length} ${mode === "video" ? "clips" : "stills"} with ${provider}…`
    );

    let completed = 0;
    const total = plan.beats.length;
    let clips: Clip[];
    try {
      clips = await Promise.all(
        plan.beats.map(async (beat) => {
          const seconds =
            mode === "video"
              ? clampSeconds(beat.durationSec)
              : Math.max(1.5, Number(beat.durationSec) || 4);
          const clip = await generateBeatClip({
            mode,
            provider,
            prompt: beatPrompt(goal, beat, style, aspectRatio, mode),
            description: `${beat.name}: ${beat.intent}`,
            size: mode === "video" ? videoSize : imageSize,
            displaySec: seconds,
            seconds: mode === "video" ? seconds : undefined,
          });
          completed += 1;
          await setStageMessage(
            runId,
            "asset_generation",
            `Generated ${completed} of ${total} ${mode === "video" ? "clips" : "stills"}…`,
            Math.round((completed / total) * 100)
          );
          return clip;
        })
      );
    } catch (err) {
      const error = describeError(err);
      await failStage(runId, "asset_generation", error);
      await markRunFailed(runId, error);
      return;
    }
    await completeStage(
      runId,
      "asset_generation",
      `Generated ${clips.length} visuals.`
    );

    // timeline_assembly
    await startStage(runId, "timeline_assembly", "Assembling the timeline…");
    const segments: TimelineSegment[] = plan.beats.map((beat, i) => ({
      id: newAssetId("seg"),
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
    await completeStage(
      runId,
      "timeline_assembly",
      `Assembled ${segments.length} segments.`
    );

    // quality_review
    await startStage(runId, "quality_review", "Reviewing the generated cut…");
    let report = null;
    try {
      const result = await critique({
        plan,
        timeline,
        clips,
        storyContext,
      });
      report = result.report;
      const patched = applyPatches(timeline, result.patches, clips);
      if (patched.segments.length > 0) timeline = patched;
      await completeStage(
        runId,
        "quality_review",
        `Reviewed cut with ${result.patches.length} patches.`
      );
    } catch (err) {
      // A critic failure should not block the run; the assembled cut is still
      // usable. Record the failure on the stage but keep moving.
      const error = describeError(err);
      await failStage(runId, "quality_review", error);
    }

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

    await completeStage(runId, "ready", "Your video is ready.");
    await markRunSucceeded(runId);
  } catch (err) {
    // Per-stage failures return early; this only catches truly unexpected errors.
    await markRunFailed(runId, describeError(err));
  }
}
