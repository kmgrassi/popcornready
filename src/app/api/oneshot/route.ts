import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getProject, saveProject } from "@/lib/store";
import { critique, planEdit } from "@/lib/agent";
import { applyPatches, sanitizeTimeline } from "@/lib/timeline";
import { providerFor } from "@/lib/generative/providers";
import {
  AspectRatio,
  Beat,
  Clip,
  CriticReport,
  EditPlan,
  Patch,
  Project,
  StoryContext,
  Timeline,
  TimelineSegment,
} from "@/lib/types";
import {
  OpenAIVideoSeconds,
  normalizeOpenAIVideoSeconds,
} from "@/lib/generative/types";
import { mergeStoryContext } from "@/lib/story-context";
import { videoQualityContextForPrompt } from "@/lib/video-quality-context";

export const dynamic = "force-dynamic";
// Per-beat video generation is slow. Give the request headroom while we move
// toward the async run/polling pipeline.
export const maxDuration = 800;

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");

type VideoProvider = "openai" | "gemini";

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function resolveVideoProviders(body: any): {
  primary: VideoProvider;
  fallback?: VideoProvider;
} {
  const hasOpenAI = Boolean((process.env.OPENAI_API_KEY || "").trim());
  const hasGemini = Boolean((process.env.GEMINI_API_KEY || "").trim());
  const requestedProvider =
    typeof body.provider === "string"
      ? body.provider.toLowerCase().trim()
      : undefined;

  if (requestedProvider === "mock") {
    throw new Error(
      "Mock provider is disabled for one-shot. Remove provider='mock' to use real video generation."
    );
  }
  if (requestedProvider === "gemini") {
    if (!hasGemini) {
      throw new Error(
        "One-shot video requested provider='gemini', but GEMINI_API_KEY is not configured."
      );
    }
    return { primary: "gemini" };
  }
  if (
    requestedProvider &&
    requestedProvider !== "openai" &&
    requestedProvider !== "gemini"
  ) {
    throw new Error(
      `One-shot video currently supports only openai or gemini providers. Received: ${requestedProvider}`
    );
  }
  if (requestedProvider === "openai") {
    if (!hasOpenAI) {
      throw new Error(
        "One-shot video requested provider='openai', but OPENAI_API_KEY is not configured."
      );
    }
    return { primary: "openai" };
  }
  if (hasGemini) {
    return { primary: "gemini", fallback: hasOpenAI ? "openai" : undefined };
  }
  if (hasOpenAI) return { primary: "openai" };
  throw new Error(
    "No video-capable provider is configured for one-shot. Set GEMINI_API_KEY or OPENAI_API_KEY."
  );
}

function parseShowCaptions(value: unknown): boolean {
  return value === true || value === "true";
}

function audioRequested(body: any, goal: string): boolean {
  if (
    body.includeAudio === false ||
    body.generateAudio === false ||
    body.audio === false ||
    body.audioMode === "none"
  ) {
    return false;
  }
  return !/\b(no audio|no music|silent video|without audio|without music)\b/i.test(
    goal
  );
}

function videoSizeForAspect(ar: AspectRatio): string {
  if (ar === "16:9") return "1280x720";
  if (ar === "1:1") return "1280x720";
  return "720x1280"; // 9:16
}

function clampSeconds(durationSec: number): OpenAIVideoSeconds {
  return normalizeOpenAIVideoSeconds(durationSec);
}

function characterContinuityBlock(goal: string): string {
  const ageMatch = goal.match(/\b(\d{1,2})[- ]year[- ]old\b/i);
  const age = ageMatch ? `${ageMatch[1]}-year-old` : "same";
  const roleMatch = goal.match(
    /\b(?:\d{1,2}[- ]year[- ]old\s+)?([a-z][a-z -]{1,40}?(?:boy|girl|child|kid|man|woman|filmmaker|creator|founder|teacher|student))\b/i
  );
  const role = roleMatch ? roleMatch[1].trim() : "main character";

  return [
    "[CHARACTER INVARIANTS]",
    `The recurring protagonist is the same ${age} ${role} in every shot, including dream/future sequences.`,
    "Keep the same face, age, hair, build, silhouette, skin tone, wardrobe anchors, emotional throughline, and live-action cinematic style across all generated clips.",
    "Do not redesign, recast, age-shift, gender-swap, or replace the protagonist. Future/famous versions must clearly read as the same person imagined forward, not a different adult.",
  ].join(" ");
}

function beatMapForPrompt(plan: EditPlan): string {
  return plan.beats
    .map((beat, index) => `${index + 1}. ${beat.name}: ${beat.intent}`)
    .join(" ");
}

function beatPrompt(
  goal: string,
  plan: EditPlan,
  beat: Beat,
  beatIndex: number,
  style: string,
  ar: AspectRatio
): string {
  const previousBeat = beatIndex > 0 ? plan.beats[beatIndex - 1] : null;
  const nextBeat =
    beatIndex < plan.beats.length - 1 ? plan.beats[beatIndex + 1] : null;
  return [
    `${style} cinematic live-action video clip with natural motion and camera movement for a ${ar} short-form video.`,
    characterContinuityBlock(goal),
    "[FULL STORY ARC]",
    goal,
    "[FULL BEAT MAP]",
    beatMapForPrompt(plan),
    "[CURRENT SHOT DELTA]",
    `This is beat ${beatIndex + 1} of ${plan.beats.length}: ${beat.name} — ${beat.intent}.`,
    previousBeat
      ? `The previous beat was "${previousBeat.name}" — ${previousBeat.intent}. Preserve continuity from that moment.`
      : "This is the opening beat. Establish the protagonist clearly and cinematically.",
    nextBeat
      ? `The next beat will be "${nextBeat.name}" — ${nextBeat.intent}. End with visual momentum that can cut into it.`
      : "This is the closing beat. Resolve the story clearly.",
    "Use explicit nouns instead of pronouns: show the same movie-loving boy/protagonist from the story, not an unrelated person.",
    `Production quality guidance: ${videoQualityContextForPrompt()}`,
    `Make the shot feel designed, not accidental: strong visual hierarchy, controlled lighting, subject-background separation, cohesive tone, and no on-screen text.`,
  ].join(" ");
}

function soundtrackPrompt(input: {
  goal: string;
  style: string;
  targetLengthSec: number;
  beats: Beat[];
}): string {
  const beatSummary = input.beats
    .map((beat) => `${beat.name}: ${beat.intent}`)
    .join(" / ");
  return [
    `Create an instrumental soundtrack for this ${input.targetLengthSec}-second video.`,
    `Choose the musical style, instrumentation, tempo, and emotional arc that best fit the creative brief. Do not add vocals.`,
    `Creative brief: ${input.goal}`,
    `Visual style: ${input.style}`,
    `Story beats: ${beatSummary}`,
    `The music should support the edit, rise and fall with the scene progression, and leave room for future dialogue or narration.`,
  ].join(" ");
}

async function generateBeatClip(input: {
  provider: VideoProvider;
  prompt: string;
  description: string;
  size: string;
  displaySec: number;
  seconds?: OpenAIVideoSeconds;
}): Promise<Clip> {
  const provider = providerFor(input.provider);
  const result =
    input.provider === "openai"
      ? await provider.generateAsset({
          provider: "openai",
          kind: "video",
          prompt: input.prompt,
          size: input.size,
          seconds: input.seconds,
        })
      : await provider.generateAsset({
          provider: "gemini",
          kind: "video",
          prompt: input.prompt,
          size: input.size,
          seconds: input.seconds,
        });
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const id = newId("vid");
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

function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("quota") ||
    message.toLowerCase().includes("rate limit")
  );
}

async function optionalOneShotStep<T>(
  label: string,
  run: () => Promise<T>
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    console.warn(`[oneshot] optional step failed: ${label}`, err);
    return null;
  }
}

async function savePartialProject(input: {
  goal: string;
  storyContext: StoryContext;
  plan: EditPlan;
  aspectRatio: AspectRatio;
  clips: Clip[];
  soundtrack?: Clip | null;
  showCaptions: boolean;
}): Promise<void> {
  const videoClips = input.clips.filter((clip) => clip.kind !== "audio");
  const clips = input.soundtrack ? [...input.clips, input.soundtrack] : input.clips;
  const segments: TimelineSegment[] = videoClips.map((clip, i) => {
    const beat = input.plan.beats[i];
    return {
      id: newId("seg"),
      clipId: clip.id,
      sourceInSec: 0,
      sourceOutSec: clip.durationSec,
      role: beat?.name || `beat ${i + 1}`,
      reason: beat?.intent || clip.description,
    };
  });
  const timeline =
    segments.length > 0
      ? sanitizeTimeline(
          { aspectRatio: input.aspectRatio, fps: 30, segments },
          clips
        )
      : null;
  if (timeline) timeline.showCaptions = input.showCaptions;

  await saveProject({
    id: "default",
    goal: input.goal,
    storyContext: input.storyContext,
    plan: input.plan,
    timeline,
    clips,
    characterProfiles: [],
    characterReferences: [],
    critic: null,
    chat: [],
    updatedAt: new Date().toISOString(),
  });
}

async function resumableClipsForGoal(goal: string): Promise<Clip[]> {
  const existing = await getProject();
  if (existing.goal !== goal || !existing.timeline) return [];
  return existing.timeline.segments
    .map((segment) => existing.clips.find((clip) => clip.id === segment.clipId))
    .filter((clip): clip is Clip => Boolean(clip && clip.kind !== "audio"));
}

async function resumableSoundtrackForGoal(goal: string): Promise<Clip | null> {
  const existing = await getProject();
  if (existing.goal !== goal) return null;
  return existing.clips.find((clip) => clip.kind === "audio") || null;
}

async function generateSoundtrack(input: {
  goal: string;
  style: string;
  targetLengthSec: number;
  beats: Beat[];
}): Promise<Clip | null> {
  if (!process.env.ELEVENLABS_API_KEY) return null;

  const prompt = soundtrackPrompt(input);
  const provider = providerFor("elevenlabs");
  const result = await provider.generateAsset({
    provider: "elevenlabs",
    kind: "audio",
    audioMode: "music",
    prompt,
    seconds: input.targetLengthSec,
    forceInstrumental: true,
  });

  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const id = newId("aud");
  const filename = `${id}_soundtrack.${result.extension}`;
  await fs.writeFile(path.join(GENERATED_DIR, filename), result.bytes);

  return {
    id,
    filename,
    url: `/generated/${filename}`,
    kind: "audio",
    durationSec: result.durationSec || input.targetLengthSec,
    description: "AI-selected instrumental soundtrack for the one-shot video.",
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

    // 2. Start the soundtrack before video generation and let it run in
    // parallel with the sequential video loop.
    const existingSoundtrack = includeAudio
      ? await resumableSoundtrackForGoal(goal)
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

    // 3. Generate a video clip per beat from scratch (no uploads required).
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
        try {
          console.info(
            `[oneshot] generating clip ${index + 1}/${plan.beats.length} with ${provider}`
          );
          clips.push(await generateBeatClip({ provider, ...clipInput }));
          console.info(
            `[oneshot] generated clip ${index + 1}/${plan.beats.length} with ${provider}`
          );
          await savePartialProject({
            goal,
            storyContext,
            plan,
            aspectRatio,
            clips,
            soundtrack,
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
          clips.push(await generateBeatClip({ provider, ...clipInput }));
          console.info(
            `[oneshot] generated clip ${index + 1}/${plan.beats.length} with ${provider}`
          );
          await savePartialProject({
            goal,
            storyContext,
            plan,
            aspectRatio,
            clips,
            soundtrack,
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
          clips,
          soundtrack,
          showCaptions,
        });
      }
      throw err;
    }
    soundtrack = await soundtrackPromise;
    if (soundtrack) clips.push(soundtrack);

    // 4. Assemble a beat-by-beat timeline from the generated clips.
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
    timeline.showCaptions = showCaptions;

    // 5. Critique once and apply patches. Critique is useful polish, but it is
    // optional: a critic failure should never discard generated clips.
    let report: CriticReport | null = null;
    let patches: Patch[] = [];
    const critiqueResult = await optionalOneShotStep("critique", () =>
      critique({
        plan,
        timeline,
        clips,
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
