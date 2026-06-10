import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { getLlmClient } from "@popcorn/llm";
import {
  type Beat,
  type CharacterProfile,
  type EditPlan,
  planBeats,
  type VideoSnapshotReview,
} from "@popcorn/shared/types";

const execFileAsync = promisify(execFile);

// Snapshot grading is a cheap pass/fail check, so it rides the fast lane
// (gpt-5-mini / claude-haiku) of the configured provider.
const REVIEW_EFFORT = "low" as const;

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    storyMatch: { type: "string", enum: ["pass", "needs_review", "fail"] },
    characterMatch: { type: "string", enum: ["pass", "needs_review", "fail"] },
    visualQuality: { type: "string", enum: ["pass", "needs_review", "fail"] },
    continuityNotes: { type: "string" },
    recommendedAction: {
      type: "string",
      enum: ["keep", "regenerate", "manual_review"],
    },
  },
  required: [
    "storyMatch",
    "characterMatch",
    "visualQuality",
    "continuityNotes",
    "recommendedAction",
  ],
};

type ReviewResult = Omit<VideoSnapshotReview, "snapshots" | "reviewer">;

function mediaTypeFor(filePath: string): "image/png" | "image/jpeg" {
  return /\.(jpe?g)$/i.test(filePath) ? "image/jpeg" : "image/png";
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

export async function extractVideoSnapshots(input: {
  videoPath: string;
  durationSec: number;
  outputDir: string;
  basename: string;
}): Promise<string[]> {
  if (!(await commandExists("ffmpeg"))) return [];
  await fs.mkdir(input.outputDir, { recursive: true });
  const duration = Math.max(1, Number(input.durationSec) || 1);
  const offsets = [0.2, 0.5, 0.8].map((ratio) =>
    Math.max(0.1, Math.min(duration - 0.1, duration * ratio))
  );

  const snapshots: string[] = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const outputPath = path.join(
      input.outputDir,
      `${input.basename}_${index + 1}.png`
    );
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      offsets[index].toFixed(2),
      "-i",
      input.videoPath,
      "-frames:v",
      "1",
      outputPath,
    ]);
    snapshots.push(outputPath);
  }
  return snapshots;
}

function beatMap(plan: EditPlan): string {
  return planBeats(plan)
    .map((beat, index) => `${index + 1}. ${beat.name}: ${beat.intent}`)
    .join("\n");
}

function characterContextText(profiles: CharacterProfile[]): string {
  if (profiles.length === 0) return "No explicit character profile.";
  return profiles
    .map((profile) =>
      [
        `Character: ${profile.name}`,
        profile.description ? `Description: ${profile.description}` : "",
        `Identity: ${profile.identityInvariants}`,
        profile.wardrobeInvariants
          ? `Wardrobe: ${profile.wardrobeInvariants}`
          : "",
        profile.styleInvariants ? `Style: ${profile.styleInvariants}` : "",
        profile.negativePrompt ? `Avoid: ${profile.negativePrompt}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

export async function reviewGeneratedVideoSnapshots(input: {
  goal: string;
  plan: EditPlan;
  beat: Beat;
  beatIndex: number;
  providerPrompt: string;
  videoPath: string;
  durationSec: number;
  characterProfiles?: CharacterProfile[];
  heroReferencePath?: string;
}): Promise<VideoSnapshotReview | null> {
  const preferredProvider =
    process.env.VIDEO_SNAPSHOT_REVIEW_PROVIDER?.toLowerCase().trim() || "openai";
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  if (!hasOpenAI && !hasAnthropic) return null;

  const outputDir = path.join(process.cwd(), "public", "generated", "snapshots");
  const snapshots = await extractVideoSnapshots({
    videoPath: input.videoPath,
    durationSec: input.durationSec,
    outputDir,
    basename: path.basename(input.videoPath, path.extname(input.videoPath)),
  });
  if (snapshots.length === 0) return null;

  const images = [
    ...(input.heroReferencePath ? [input.heroReferencePath] : []),
    ...snapshots,
  ].map((imagePath) => ({
    path: imagePath,
    mediaType: mediaTypeFor(imagePath),
  }));

  const sys = `You review generated video clips for an AI video editor.
You receive still snapshots extracted from a clip, optionally preceded by a
hero character reference image. Judge whether the generated clip appears to
match the requested story beat, recurring character, and baseline visual
quality. Call the required result tool with the review.`;

  const user = `Full user prompt:
${input.goal}

Full beat map:
${beatMap(input.plan)}

Current beat:
${input.beatIndex + 1}. ${input.beat.name}: ${input.beat.intent}

Character requirements:
${characterContextText(input.characterProfiles || [])}

Provider prompt used for this clip:
${input.providerPrompt}

Images:
${input.heroReferencePath ? "Image 1 is the hero character reference. " : ""}
The remaining images are early, middle, and late snapshots from the generated
video clip.

Review strictly but practically. Use "needs_review" when the still frames are
ambiguous. Recommend "regenerate" only for clear story or character failures.`;

  const env =
    preferredProvider === "anthropic" && hasAnthropic
      ? { ...process.env, LLM_PROVIDER: "anthropic" }
      : hasOpenAI
        ? { ...process.env, LLM_PROVIDER: "openai" }
        : { ...process.env, LLM_PROVIDER: "anthropic" };
  const client = getLlmClient(env);
  const result = await client.structuredVision<ReviewResult>({
    cachedSystem: sys,
    user,
    schema: reviewSchema,
    images,
    maxTokens: 2000,
    effort: REVIEW_EFFORT,
  });

  return {
    ...result,
    snapshots: snapshots.map((snapshot) =>
      snapshot.startsWith(path.join(process.cwd(), "public"))
        ? snapshot.slice(path.join(process.cwd(), "public").length)
        : snapshot
    ),
    reviewer: {
      provider: client.provider,
      model: client.modelFor(REVIEW_EFFORT),
    },
  };
}
