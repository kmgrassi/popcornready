import { NextRequest, NextResponse } from "next/server";
import { saveProject } from "@/lib/store";
import { critique, planEdit } from "@/lib/agent";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import { compileTimelineViaEditGraph, synthesizeEditGraph } from "@/lib/edit-graph";
import {
  AspectRatio,
  Clip,
  CriticReport,
  Patch,
  Project,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "@/lib/types";
import { mergeStoryContext } from "@/lib/story-context";
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

export const dynamic = "force-dynamic";
// Per-beat video generation is slow. Give the request headroom while we move
// toward the async run/polling pipeline.
export const maxDuration = 800;

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

    // 2. Create or reuse one hero-frame character reference so every video
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

    // 3. Start the soundtrack before video generation and let it run in
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

    // 4. Generate a video clip per beat from scratch (no uploads required).
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
        const firstFramePath =
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
                })
              )) || undefined
            : undefined;
        try {
          console.info(
            `[oneshot] generating clip ${index + 1}/${plan.beats.length} with ${provider}` +
              (firstFramePath ? " (per-beat keyframe)" : "")
          );
          clips.push(
            await generateBeatClip({
              provider,
              ...clipInput,
              characterContext,
              firstFramePath,
            })
          );
          console.info(
            `[oneshot] generated clip ${index + 1}/${plan.beats.length} with ${provider}`
          );
          await savePartialProject({
            goal,
            storyContext,
            plan,
            aspectRatio,
            clips: [...characterClips, ...clips],
            soundtrack,
            characterProfiles,
            characterReferences,
            showCaptions,
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
          clips.push(
            await generateBeatClip({
              provider,
              ...clipInput,
              characterContext,
              firstFramePath,
            })
          );
          console.info(
            `[oneshot] generated clip ${index + 1}/${plan.beats.length} with ${provider}`
          );
          await savePartialProject({
            goal,
            storyContext,
            plan,
            aspectRatio,
            clips: [...characterClips, ...clips],
            soundtrack,
            characterProfiles,
            characterReferences,
            showCaptions,
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
          aspectRatio,
          clips: [...characterClips, ...clips],
          soundtrack,
          characterProfiles,
          characterReferences,
          showCaptions,
        });
      }
      throw err;
    }
    soundtrack = await soundtrackPromise;
    const projectClips = [...characterClips, ...clips];
    if (soundtrack) projectClips.push(soundtrack);

    // 5. Assemble a beat-by-beat timeline from the generated clips.
    const segments: TimelineSegment[] = plan.beats.map((beat, i) => ({
      id: newId("seg"),
      clipId: clips[i].id,
      sourceInSec: 0,
      sourceOutSec: clips[i].durationSec,
      role: beat.name,
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

    // 6. Critique once and apply patches. Critique is useful polish, but it is
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
      characterProfiles,
      characterReferences,
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
