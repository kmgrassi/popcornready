import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { MODEL, structuredVisionCall } from "@/lib/anthropic";
import type {
  Beat,
  CharacterProfile,
  EditPlan,
  VideoSnapshotReview,
} from "@/lib/types";

const execFileAsync = promisify(execFile);
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_REVIEW_MODEL = "gpt-4.1-mini";

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
  return plan.beats
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

function extractOpenAIOutputText(payload: any): string {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks: string[] = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("");
}

function parseReviewJson(text: string): ReviewResult {
  try {
    return JSON.parse(text) as ReviewResult;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as ReviewResult;
    throw new Error(`Reviewer did not return JSON: ${text.slice(0, 500)}`);
  }
}

async function imageInputBlock(imagePath: string) {
  const bytes = await fs.readFile(imagePath);
  const mediaType = mediaTypeFor(imagePath);
  return {
    type: "input_image",
    image_url: `data:${mediaType};base64,${bytes.toString("base64")}`,
    detail: "high",
  };
}

async function reviewWithOpenAI(input: {
  prompt: string;
  imagePaths: string[];
}): Promise<{ result: ReviewResult; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set for video snapshot review.");
  const model =
    process.env.OPENAI_VIDEO_REVIEW_MODEL?.trim() || DEFAULT_OPENAI_REVIEW_MODEL;
  const imageBlocks = await Promise.all(input.imagePaths.map(imageInputBlock));
  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${input.prompt}

Return only a JSON object with this exact shape:
{
  "storyMatch": "pass" | "needs_review" | "fail",
  "characterMatch": "pass" | "needs_review" | "fail",
  "visualQuality": "pass" | "needs_review" | "fail",
  "continuityNotes": "string",
  "recommendedAction": "keep" | "regenerate" | "manual_review"
}`,
            },
            ...imageBlocks,
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`OpenAI snapshot review failed: ${res.status} ${error}`);
  }

  const payload = await res.json();
  return { result: parseReviewJson(extractOpenAIOutputText(payload)), model };
}

async function reviewWithAnthropic(input: {
  system: string;
  prompt: string;
  images: { path: string; mediaType: "image/png" | "image/jpeg" }[];
}): Promise<{ result: ReviewResult; model: string }> {
  const result = await structuredVisionCall<ReviewResult>({
    cachedSystem: input.system,
    user: input.prompt,
    schema: reviewSchema,
    images: input.images,
    maxTokens: 2000,
  });
  return { result, model: MODEL };
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
  const imagePaths = images.map((image) => image.path);

  const sys = `You review generated video clips for an AI video editor.
You receive still snapshots extracted from a clip, optionally preceded by a
hero character reference image. Judge whether the generated clip appears to
match the requested story beat, recurring character, and baseline visual
quality. Return JSON only.`;

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

  const review =
    preferredProvider === "anthropic" && hasAnthropic
      ? {
          provider: "anthropic",
          ...(await reviewWithAnthropic({ system: sys, prompt: user, images })),
        }
      : hasOpenAI
        ? {
            provider: "openai",
            ...(await reviewWithOpenAI({ prompt: `${sys}\n\n${user}`, imagePaths })),
          }
        : {
            provider: "anthropic",
            ...(await reviewWithAnthropic({ system: sys, prompt: user, images })),
          };

  return {
    ...review.result,
    snapshots: snapshots.map((snapshot) =>
      snapshot.startsWith(path.join(process.cwd(), "public"))
        ? snapshot.slice(path.join(process.cwd(), "public").length)
        : snapshot
    ),
    reviewer: {
      provider: review.provider,
      model: review.model,
    },
  };
}
