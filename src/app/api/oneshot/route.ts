import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { saveProject } from "@/lib/store";
import { critique, critiquePlan, planEdit } from "@/lib/agent";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import { compileTimelineViaEditGraph, synthesizeEditGraph } from "@/lib/edit-graph";
import { reviewGeneratedVideoSnapshots } from "@/lib/generative/video-snapshot-review";
import type {
  CharacterGenerationContext,
  OpenAIVideoSeconds,
} from "@/lib/generative/types";
import {
  AspectRatio,
  Beat,
  CharacterProfile,
  Clip,
  CriticReport,
  EditPlan,
  Patch,
  Project,
  StoryContext,
  Timeline,
  TimelineSegment,
  VideoSnapshotReview,
} from "@/lib/types";
import { mergeStoryContext } from "@/lib/story-context";
import type { Asset, AssetSelection } from "@/lib/assets/types";
import { addAsset, DEFAULT_PROJECT_ID, setSelection } from "@/lib/assets/pool";
import { oneShotCharacterContext } from "@/lib/oneshot/character-reference";
import {
  audioRequested,
  beatPrompt,
  clampSeconds,
  generateBeatClip,
  generateBeatKeyframe,
  generateCharacterHeroFrame,
  generateSoundtrack,
  isQuotaError,
  newId,
  optionalOneShotStep,
  parseShowCaptions,
  resolveVideoProviders,
  resumableCharacterForGoal,
  resumableClipsForGoal,
  resumableSoundtrackForGoal,
  savePartialProject,
  videoSizeForAspect,
} from "./helpers";
import type { VideoProvider } from "./helpers";

export const dynamic = "force-dynamic";
// Per-beat video generation is slow. Give the request headroom while we move
// toward the async run/polling pipeline.
export const maxDuration = 800;

function attachVideoReview(clip: Clip, review: VideoSnapshotReview | null): Clip {
  if (!review) return clip;
  clip.videoReview = review;
  const consistencyReview = {
    identity: review.characterMatch,
    wardrobe: "needs_review" as const,
    style: review.visualQuality,
    temporal: review.storyMatch,
    notes: review.continuityNotes,
  };
  if (clip.characterBinding) {
    clip.characterBinding.consistencyReview = consistencyReview;
    clip.characterBinding.videoReview = review;
  }
  if (clip.generatedBy?.characterBinding) {
    clip.generatedBy.characterBinding.consistencyReview = consistencyReview;
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
  characterProfiles: CharacterProfile[];
  heroReferencePath?: string;
}): Promise<Clip> {
  const review = await optionalOneShotStep("video snapshot review", () =>
    reviewGeneratedVideoSnapshots({
      goal: input.goal,
      plan: input.plan,
      beat: input.beat,
      beatIndex: input.beatIndex,
      providerPrompt: input.prompt,
      videoPath: path.join(process.cwd(), "public", input.clip.url),
      durationSec: input.clip.durationSec,
      characterProfiles: input.characterProfiles,
      heroReferencePath: input.heroReferencePath,
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

// Record the pooled beat_keyframe asset that seeded this clip's image-to-video
// first frame as a provenance input edge (asset-pool PR D, North Star Principle
// 9). The keyframe is no longer a discarded path — the clip names the asset it
// grew from. No-op when keyframes are disabled / unavailable.
function recordFirstFrameEdge(clip: Clip, firstFrameAssetId?: string): void {
  if (!firstFrameAssetId || !clip.generatedBy) return;
  clip.generatedBy.inputs = {
    ...clip.generatedBy.inputs,
    firstFrameAssetId,
  };
}

async function generateBeatClipWithReview(input: {
  provider: VideoProvider;
  clipInput: {
    prompt: string;
    description: string;
    size: string;
    displaySec: number;
    seconds: OpenAIVideoSeconds;
  };
  characterContext?: CharacterGenerationContext;
  firstFramePath?: string;
  goal: string;
  plan: EditPlan;
  beat: Beat;
  beatIndex: number;
  characterProfiles: CharacterProfile[];
  heroReferencePath?: string;
}): Promise<Clip> {
  const firstClip = await reviewClipIfPossible({
    goal: input.goal,
    plan: input.plan,
    beat: input.beat,
    beatIndex: input.beatIndex,
    prompt: input.clipInput.prompt,
    characterProfiles: input.characterProfiles,
    heroReferencePath: input.heroReferencePath,
    clip: await generateBeatClip({
      provider: input.provider,
      ...input.clipInput,
      characterContext: input.characterContext,
      firstFramePath: input.firstFramePath,
    }),
  });

  const review = firstClip.videoReview;
  if (review?.recommendedAction !== "regenerate") return firstClip;

  const retryPrompt = promptWithVisualFeedback(input.clipInput.prompt, review);
  console.info(
    `[oneshot] regenerating clip ${input.beatIndex + 1}/${input.plan.beats.length} from visual review feedback`
  );
  try {
    return await reviewClipIfPossible({
      goal: input.goal,
      plan: input.plan,
      beat: input.beat,
      beatIndex: input.beatIndex,
      prompt: retryPrompt,
      characterProfiles: input.characterProfiles,
      heroReferencePath: input.heroReferencePath,
      clip: await generateBeatClip({
        provider: input.provider,
        ...input.clipInput,
        prompt: retryPrompt,
        characterContext: input.characterContext,
        firstFramePath: input.firstFramePath,
      }),
    });
  } catch (err) {
    console.warn(
      `[oneshot] visual-review regeneration failed for clip ${input.beatIndex + 1}; keeping first reviewed clip`,
      err
    );
    return firstClip;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const goal = String(body.goal || "").trim();
    const targetLengthSec = Number(body.targetLengthSec) || 30;
    const style = String(body.style || "fast-paced social ad");
    const aspectRatio = (body.aspectRatio || "9:16") as AspectRatio;
    const showCaptions = parseShowCaptions(body.showCaptions);
    const storyContext = mergeStoryContext(body.storyContext as StoryContext);
    const providers = resolveVideoProviders(body);
    const includeAudio = audioRequested(body, goal);

    if (!goal) {
      return NextResponse.json(
        { error: "Describe the video you want to create." },
        { status: 400 }
      );
    }

    // 1. Plan: goal -> beats
    let plan = await planEdit({
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

    // 2. Critique and revise the plan before expensive media generation.
    const preGenerationReview = await optionalOneShotStep(
      "pre-generation plan review",
      () =>
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

    // 3. Create or reuse one hero-frame character reference so every video
    // beat can use the same visual anchor.
    const existingCharacter = await resumableCharacterForGoal(goal);
    const generatedCharacter = existingCharacter
      ? null
      : await optionalOneShotStep("character hero frame", () =>
          generateCharacterHeroFrame({ goal, style })
        );
    const character = existingCharacter || generatedCharacter;
    const characterProfiles = character ? [character.profile] : [];
    const characterReferences = character ? [character.reference] : [];
    const characterClips = character ? [character.clip] : [];

    // Per-beat keyframes: generate a fresh hero-conditioned image per beat and
    // use it as the image-to-video first frame, so each shot opens on its own
    // scene instead of the same static hero portrait. Requires Gemini (the only
    // image model that will edit a photorealistic minor); set
    // ONESHOT_BEAT_KEYFRAMES=0 to fall back to seeding clips with the hero frame.
    const heroPath = character?.path;
    const useBeatKeyframes =
      Boolean(heroPath) &&
      Boolean(process.env.GEMINI_API_KEY) &&
      process.env.ONESHOT_BEAT_KEYFRAMES !== "0";

    // 4. Start the soundtrack before video generation and let it run in
    // parallel with the sequential video loop.
    const existingSoundtrack = includeAudio
      ? await resumableSoundtrackForGoal({ goal, style, targetLengthSec })
      : null;
    const soundtrackPromise: Promise<Clip | null> =
      includeAudio && !existingSoundtrack
        ? optionalOneShotStep("soundtrack", () =>
            generateSoundtrack({
              goal,
              style,
              targetLengthSec,
              beats: plan.beats,
            })
          )
        : Promise.resolve(existingSoundtrack);

    // 5. Generate a video clip per beat from scratch (no uploads required).
    const videoSize = videoSizeForAspect(aspectRatio);
    const clips: Clip[] = (await resumableClipsForGoal(goal)).slice(
      0,
      plan.beats.length
    );
    if (clips.length > 0) {
      console.info(
        `[oneshot] resuming with ${clips.length}/${plan.beats.length} existing generated clips`
      );
    }
    let provider = providers.primary;
    let soundtrack: Clip | null = existingSoundtrack;

    // Per-beat keyframes are now first-class pooled assets (asset-pool PR D,
    // North Star Principle 9 "nothing is throwaway"). Accumulate them and their
    // active beat_keyframe selections in an in-memory project so the append-only
    // pool helpers stay the single source of truth; persist via savePartialProject.
    const poolProject: Project = {
      id: DEFAULT_PROJECT_ID,
      goal,
      plan,
      timeline: null,
      clips: [],
      assets: [],
      selections: [],
      critic: null,
      chat: [],
      updatedAt: new Date().toISOString(),
    };
    const keyframeAssets = (): Asset[] => poolProject.assets ?? [];
    const keyframeSelections = (): AssetSelection[] => poolProject.selections ?? [];
    try {
      for (let index = clips.length; index < plan.beats.length; index += 1) {
        const beat = plan.beats[index];
        const seconds = clampSeconds(beat.durationSec);
        const clipInput = {
          prompt: beatPrompt(goal, plan, beat, index, style, aspectRatio),
          description: `${beat.name}: ${beat.intent}`,
          size: videoSize,
          displaySec: seconds,
          seconds,
        };
        const characterContext =
          character && character.path
            ? oneShotCharacterContext({
                profile: character.profile,
                reference: character.reference,
                referencePath: character.path,
                referenceUrl: character.clip.url,
                originalPrompt: goal,
                providerPrompt: clipInput.prompt,
              })
            : undefined;
        const keyframe =
          useBeatKeyframes && heroPath
            ? (await optionalOneShotStep(`beat ${index + 1} keyframe`, () =>
                generateBeatKeyframe({
                  goal,
                  style,
                  beat,
                  beatIndex: index,
                  totalBeats: plan.beats.length,
                  aspectRatio,
                  heroPath,
                  projectId: poolProject.id,
                  anchorAssetId: character?.clip.id,
                })
              )) || undefined
            : undefined;
        // Record the keyframe as a first-class pooled asset + active selection
        // for this beat (asset-pool PR D); the clip's image-to-video first frame
        // is the asset's local file path, and the edge is recorded on the clip
        // provenance below via firstFrameAssetId.
        let firstFrameAssetId: string | undefined;
        if (keyframe) {
          addAsset(poolProject, keyframe.asset);
          if (beat.id) {
            setSelection(
              poolProject,
              "beat_keyframe",
              beat.id,
              keyframe.asset.id
            );
          }
          firstFrameAssetId = keyframe.asset.id;
        }
        const firstFramePath = keyframe?.path;
        try {
          console.info(
            `[oneshot] generating clip ${index + 1}/${plan.beats.length} with ${provider}` +
              (firstFramePath ? " (per-beat keyframe)" : "")
          );
          const generatedClip = await generateBeatClipWithReview({
            provider,
            clipInput,
            characterContext,
            firstFramePath,
            goal,
            plan,
            beat,
            beatIndex: index,
            characterProfiles,
            heroReferencePath: character?.path,
          });
          recordFirstFrameEdge(generatedClip, firstFrameAssetId);
          clips.push(generatedClip);
          console.info(
            `[oneshot] generated clip ${index + 1}/${plan.beats.length} with ${provider}`
          );
          await savePartialProject({
            goal,
            storyContext,
            plan,
            preGenerationReview,
            aspectRatio,
            clips: [...characterClips, ...clips],
            soundtrack,
            characterProfiles,
            characterReferences,
            showCaptions,
            assets: keyframeAssets(),
            selections: keyframeSelections(),
          });
        } catch (err) {
          if (
            !providers.fallback ||
            provider === providers.fallback ||
            !isQuotaError(err)
          ) {
            throw err;
          }
          console.warn(
            `[oneshot] ${provider} quota/rate-limit failure; retrying clip ${index + 1}/${plan.beats.length} with ${providers.fallback}`
          );
          provider = providers.fallback;
          const generatedClip = await generateBeatClipWithReview({
            provider,
            clipInput,
            characterContext,
            firstFramePath,
            goal,
            plan,
            beat,
            beatIndex: index,
            characterProfiles,
            heroReferencePath: character?.path,
          });
          recordFirstFrameEdge(generatedClip, firstFrameAssetId);
          clips.push(generatedClip);
          console.info(
            `[oneshot] generated clip ${index + 1}/${plan.beats.length} with ${provider}`
          );
          await savePartialProject({
            goal,
            storyContext,
            plan,
            preGenerationReview,
            aspectRatio,
            clips: [...characterClips, ...clips],
            soundtrack,
            characterProfiles,
            characterReferences,
            showCaptions,
            assets: keyframeAssets(),
            selections: keyframeSelections(),
          });
        }
      }
    } catch (err) {
      soundtrack = await soundtrackPromise;
      if (soundtrack || clips.length > 0) {
        await savePartialProject({
          goal,
          storyContext,
          plan,
          preGenerationReview,
          aspectRatio,
          clips: [...characterClips, ...clips],
          soundtrack,
          characterProfiles,
          characterReferences,
          showCaptions,
          assets: keyframeAssets(),
          selections: keyframeSelections(),
        });
      }
      throw err;
    }
    soundtrack = await soundtrackPromise;
    const projectClips = [...characterClips, ...clips];
    if (soundtrack) projectClips.push(soundtrack);

    // 6. Assemble a beat-by-beat timeline from the generated clips.
    const segments: TimelineSegment[] = plan.beats.map((beat, i) => ({
      id: newId("seg"),
      clipId: clips[i].id,
      sourceInSec: 0,
      sourceOutSec: clips[i].durationSec,
      role: beat.name,
      beatId: beat.id,
      reason: beat.intent,
    }));
    let timeline: Timeline = sanitizeTimeline(
      compileTimelineViaEditGraph({
        id: "oneshot_initial",
        goal,
        plan,
        timeline: { aspectRatio, fps: 30, segments },
        clips,
        storyContext,
      }),
      projectClips
    );
    timeline.showCaptions = showCaptions;

    // 7. Critique once and apply patches. Critique is useful polish, but it is
    // optional: a critic failure should never discard generated clips.
    let report: CriticReport | null = null;
    let patches: Patch[] = [];
    const critiqueResult = await optionalOneShotStep("critique", () =>
      critique({
        plan,
        timeline,
        clips: projectClips,
        storyContext,
      })
    );
    if (critiqueResult) {
      report = critiqueResult.report;
      patches = critiqueResult.patches;
      const patched = applyPatches(timeline, patches, clips);
      if (patched.segments.length > 0) timeline = patched;
    }

    const project: Project = {
      id: "default",
      goal,
      storyContext,
      editGraph: synthesizeEditGraph({
        id: "oneshot_final",
        goal,
        plan,
        timeline,
        clips,
        storyContext,
      }),
      plan,
      timeline,
      clips: projectClips,
      ...(keyframeAssets().length ? { assets: keyframeAssets() } : {}),
      ...(keyframeSelections().length
        ? { selections: keyframeSelections() }
        : {}),
      characterProfiles,
      characterReferences,
      preGenerationReview,
      critic: report,
      chat: [],
      updatedAt: new Date().toISOString(),
    };
    await saveProject(project);

    return NextResponse.json({
      project,
      mode: "video",
      provider,
      generatedClips: clips.filter((clip) => clip.kind !== "audio").length,
      generatedSoundtrack: Boolean(soundtrack),
      appliedPatches: patches.length,
    });
  } catch (err: any) {
    console.error("[oneshot] generation failed", err);
    return NextResponse.json(
      { error: err?.message || "One-shot generation failed" },
      { status: 500 }
    );
  }
}
