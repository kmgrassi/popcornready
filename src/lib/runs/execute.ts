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
import { compileTimelineViaEditGraph } from "@/lib/edit-graph";
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

type VisualProvider = "openai" | "gemini";

function newAssetId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function resolveVideoProviders(): {
  primary: VisualProvider;
  fallback?: VisualProvider;
} {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  if (hasGemini) {
    return { primary: "gemini", fallback: hasOpenAI ? "openai" : undefined };
  }
  if (hasOpenAI) return { primary: "openai" };
  throw new Error(
    "No video-capable provider is configured for one-shot. Set GEMINI_API_KEY or OPENAI_API_KEY."
  );
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
  ar: AspectRatio
): string {
  return [
    `${style} cinematic live-action video clip with natural motion and camera movement for a ${ar} short-form video.`,
    `Beat: ${beat.name} — ${beat.intent}.`,
    `Overall concept: ${goal}.`,
    `Production quality guidance: ${videoQualityContextForPrompt()}`,
    `Make the shot feel designed, not accidental: strong visual hierarchy, controlled lighting, subject-background separation, cohesive tone, and no on-screen text.`,
  ].join(" ");
}

async function generateBeatClip(input: {
  provider: VisualProvider;
  prompt: string;
  description: string;
  size: string;
  displaySec: number;
  seconds?: number;
}): Promise<Clip> {
  const provider = providerFor(input.provider);
  const result =
    input.provider === "gemini"
      ? await provider.generateAsset({
          provider: "gemini",
          kind: "video",
          prompt: input.prompt,
          size: input.size,
          seconds: input.seconds,
        })
      : await provider.generateAsset({
          provider: "openai",
          kind: "video",
          prompt: input.prompt,
          size: input.size,
          seconds: input.seconds,
        });
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const id = newAssetId("vid");
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
      ...(typeof result.costUsd === "number" ? { costUsd: result.costUsd } : {}),
    },
  };
}

function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("quota") ||
    message.toLowerCase().includes("rate limit")
  );
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
    const providers = resolveVideoProviders();
    const videoSize = videoSizeForAspect(aspectRatio);
    await startStage(
      runId,
      "asset_generation",
      `Generating ${plan.beats.length} clips with ${providers.primary}…`
    );

    let completed = 0;
    const total = plan.beats.length;
    let clips: Clip[];
    try {
      clips = [];
      let provider = providers.primary;
      for (const beat of plan.beats) {
        const seconds = clampSeconds(beat.durationSec);
        const clipInput = {
          prompt: beatPrompt(goal, beat, style, aspectRatio),
          description: `${beat.name}: ${beat.intent}`,
          size: videoSize,
          displaySec: seconds,
          seconds,
        };
        let clip: Clip;
        try {
          clip = await generateBeatClip({ provider, ...clipInput });
        } catch (err) {
          if (
            !providers.fallback ||
            provider === providers.fallback ||
            !isQuotaError(err)
          ) {
            throw err;
          }
          provider = providers.fallback;
          await setStageMessage(
            runId,
            "asset_generation",
            `Gemini quota was exhausted; continuing with ${provider}…`
          );
          clip = await generateBeatClip({ provider, ...clipInput });
        }
        completed += 1;
        await setStageMessage(
          runId,
          "asset_generation",
          `Generated ${completed} of ${total} clips…`,
          Math.round((completed / total) * 100)
        );
        clips.push(clip);
      }
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
      compileTimelineViaEditGraph({
        id: `${runId}_initial`,
        goal,
        plan,
        timeline: { aspectRatio, fps: 30, segments },
        clips,
        storyContext,
      }),
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
