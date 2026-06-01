import { NextRequest, NextResponse } from "next/server";
import { saveProject } from "@/lib/store";
import { critique, planEdit } from "@/lib/agent";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import { compileTimelineViaEditGraph, synthesizeEditGraph } from "@/lib/edit-graph";
import {
  AspectRatio,
  CharacterProfile,
  CharacterReference,
  Clip,
  CriticReport,
  Patch,
  Project,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "@/lib/types";
import type { ResolvedAnchor } from "@/lib/generative/beat-clip";
import { mergeStoryContext } from "@/lib/story-context";
import {
  audioRequested,
  beatPrompt,
  clampSeconds,
  generateAnchorImage,
  generateBeatClip,
  generateBeatKeyframe,
  generateSoundtrack,
  isQuotaError,
  newId,
  optionalOneShotStep,
  parseShowCaptions,
  resolveVideoProviders,
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

    // 2. Resolve the recurring reference anchors the planner identified
    // (a character, product, location, logo/screen, …) and generate one
    // reusable helper image per anchor. Per beat, a keyframe is conditioned on
    // the anchors that shot uses; beats with no anchors run as plain
    // text-to-video. Requires Gemini (nano-banana — the only image model that
    // renders/edits a photorealistic minor); set ONESHOT_BEAT_KEYFRAMES=0 to
    // disable keyframes entirely.
    const characterProfiles: CharacterProfile[] = [];
    const characterReferences: CharacterReference[] = [];
    const characterClips: Clip[] = [];
    const useBeatKeyframes =
      Boolean(process.env.GEMINI_API_KEY) &&
      process.env.ONESHOT_BEAT_KEYFRAMES !== "0";
    const planAnchorSubjects = new Map(
      (plan.anchors || []).map((anchor) => [anchor.id, anchor.subject])
    );
    const anchorImages = new Map<string, ResolvedAnchor>();
    if (useBeatKeyframes) {
      for (const anchor of plan.anchors || []) {
        const imagePath = await optionalOneShotStep(`anchor ${anchor.id}`, () =>
          generateAnchorImage({ subject: anchor.subject, style, aspectRatio })
        );
        if (imagePath) {
          anchorImages.set(anchor.id, {
            id: anchor.id,
            subject: anchor.subject,
            imagePath,
          });
        }
      }
      if (anchorImages.size > 0) {
        console.info(
          `[oneshot] generated ${anchorImages.size}/${(plan.anchors || []).length} reference anchor image(s)`
        );
      }
    }

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
        const beatAnchorIds = beat.anchorIds || [];
        const beatAnchorSubjects = beatAnchorIds
          .map((id) => planAnchorSubjects.get(id))
          .filter((subject): subject is string => Boolean(subject));
        const clipInput = {
          prompt: beatPrompt(
            goal,
            plan,
            beat,
            index,
            style,
            aspectRatio,
            beatAnchorSubjects
          ),
          description: `${beat.name}: ${beat.intent}`,
          size: videoSize,
          displaySec: seconds,
          seconds,
        };
        // Condition this shot's keyframe on the anchors it actually uses;
        // shots with no anchors generate as plain text-to-video.
        const beatAnchors = beatAnchorIds
          .map((id) => anchorImages.get(id))
          .filter((anchor): anchor is ResolvedAnchor => Boolean(anchor));
        const firstFramePath =
          beatAnchors.length > 0
            ? (await optionalOneShotStep(`beat ${index + 1} keyframe`, () =>
                generateBeatKeyframe({
                  beat,
                  beatIndex: index,
                  totalBeats: plan.beats.length,
                  style,
                  aspectRatio,
                  anchors: beatAnchors,
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
