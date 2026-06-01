// Execute a generation run end-to-end and emit stage progress as it goes.
//
// This is the asynchronous twin of /api/oneshot: the same planner -> per-beat
// generation -> assembly -> critique flow, but each step writes progress into
// the run store so the polling UI can render a live stage rail. The final
// project is saved through the existing project store so the editor surface
// keeps working unchanged.

import { promises as fs } from "fs";
import path from "path";
import { critique, critiquePlan, planEdit } from "@/lib/agent";
import { providerFor } from "@/lib/generative/providers";
import { reviewGeneratedVideoSnapshots } from "@/lib/generative/video-snapshot-review";
import { compileTimelineViaEditGraph, synthesizeEditGraph } from "@/lib/edit-graph";
import { saveProject } from "@/lib/store";
import { mergeStoryContext } from "@/lib/story-context";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import {
  AspectRatio,
  Beat,
  Clip,
  EditPlan,
  PlanCritiqueReport,
  Project,
  StoryContext,
  Timeline,
  TimelineSegment,
  VideoSnapshotReview,
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

type VisualProvider = "openai" | "gemini" | "runway" | "ltx";

function newAssetId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function resolveVideoProviders(): {
  primary: VisualProvider;
  fallback?: VisualProvider;
} {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasRunway = !!(process.env.RUNWAYML_API_SECRET || process.env.RUNWAY_API_KEY);
  const hasLtx = !!process.env.LTX_API_KEY;
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
      : input.provider === "openai"
        ? await provider.generateAsset({
            provider: "openai",
            kind: "video",
            prompt: input.prompt,
            size: input.size,
            seconds: input.seconds,
          })
        : input.provider === "runway"
          ? await provider.generateAsset({
              provider: "runway",
              kind: "video",
              prompt: input.prompt,
              size: input.size,
              seconds: input.seconds,
            })
          : await provider.generateAsset({
              provider: "ltx",
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

async function optionalRunStep<T>(
  label: string,
  run: () => Promise<T>
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    console.warn(`[run] optional step failed: ${label}`, err);
    return null;
  }
}

function attachVideoReview(clip: Clip, review: VideoSnapshotReview | null): Clip {
  if (!review) return clip;
  clip.videoReview = review;
  if (!clip.characterBinding) return clip;
  clip.characterBinding.consistencyReview = {
    identity: review.characterMatch,
    wardrobe: "needs_review",
    style: review.visualQuality,
    temporal: review.storyMatch,
    notes: review.continuityNotes,
  };
  clip.characterBinding.videoReview = review;
  if (clip.generatedBy?.characterBinding) {
    clip.generatedBy.characterBinding.consistencyReview =
      clip.characterBinding.consistencyReview;
    clip.generatedBy.characterBinding.videoReview = review;
  }
  return clip;
}

async function reviewClipIfPossible(input: {
  goal: string;
  plan: EditPlan;
  beat: Beat;
  beatIndex: number;
  prompt: string;
  clip: Clip;
}): Promise<Clip> {
  const review = await optionalRunStep("video snapshot review", () =>
    reviewGeneratedVideoSnapshots({
      goal: input.goal,
      plan: input.plan,
      beat: input.beat,
      beatIndex: input.beatIndex,
      providerPrompt: input.prompt,
      videoPath: path.join(process.cwd(), "public", input.clip.url),
      durationSec: input.clip.durationSec,
    })
  );
  return attachVideoReview(input.clip, review);
}

function promptWithVisualFeedback(prompt: string, review: VideoSnapshotReview): string {
  return [
    prompt,
    "[PREVIOUS VISUAL REVIEW FEEDBACK]",
    `Story match: ${review.storyMatch}.`,
    `Character match: ${review.characterMatch}.`,
    `Visual quality: ${review.visualQuality}.`,
    `Reviewer notes: ${review.continuityNotes}`,
    "Regenerate the shot to fix these issues while preserving the full story arc, current beat intent, and character identity.",
  ].join("\n");
}

async function generateBeatClipWithReview(input: {
  provider: VisualProvider;
  clipInput: {
    prompt: string;
    description: string;
    size: string;
    displaySec: number;
    seconds: number;
  };
  goal: string;
  plan: EditPlan;
  beat: Beat;
  beatIndex: number;
}): Promise<Clip> {
  const firstClip = await reviewClipIfPossible({
    goal: input.goal,
    plan: input.plan,
    beat: input.beat,
    beatIndex: input.beatIndex,
    prompt: input.clipInput.prompt,
    clip: await generateBeatClip({ provider: input.provider, ...input.clipInput }),
  });
  const review = firstClip.videoReview;
  if (review?.recommendedAction !== "regenerate") return firstClip;

  const retryPrompt = promptWithVisualFeedback(input.clipInput.prompt, review);
  console.info(
    `[run] regenerating clip ${input.beatIndex + 1}/${input.plan.beats.length} from visual review feedback`
  );
  try {
    return await reviewClipIfPossible({
      goal: input.goal,
      plan: input.plan,
      beat: input.beat,
      beatIndex: input.beatIndex,
      prompt: retryPrompt,
      clip: await generateBeatClip({
        provider: input.provider,
        ...input.clipInput,
        prompt: retryPrompt,
      }),
    });
  } catch (err) {
    console.warn(
      `[run] visual-review regeneration failed for clip ${input.beatIndex + 1}; keeping first reviewed clip`,
      err
    );
    return firstClip;
  }
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
    let plan: EditPlan;
    let preGenerationReview: PlanCritiqueReport | null = null;
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
    preGenerationReview = await optionalRunStep("pre-generation plan review", () =>
      critiquePlan({
        goal,
        plan,
        style,
        aspectRatio,
        storyContext,
      })
    );
    if (preGenerationReview?.revisedPlan?.beats?.length) {
      plan = preGenerationReview.revisedPlan;
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
          clip = await generateBeatClipWithReview({
            provider,
            clipInput,
            goal,
            plan,
            beat,
            beatIndex: completed,
          });
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
          clip = await generateBeatClipWithReview({
            provider,
            clipInput,
            goal,
            plan,
            beat,
            beatIndex: completed,
          });
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
      editGraph: synthesizeEditGraph({
        id: `${runId}_final`,
        goal,
        plan,
        timeline,
        clips,
        storyContext,
      }),
      plan,
      timeline,
      clips,
      characterProfiles: [],
      characterReferences: [],
      preGenerationReview,
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
