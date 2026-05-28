import { structuredCall } from "../anthropic";
import {
  Clip,
  EditPlan,
  GenerationPreflightIssue,
  GenerationPreflightPass,
  GenerationPreflightResult,
  StoryContext,
} from "../types";
import { storyContextForPrompt } from "../story-context";
import {
  AudioGenerationMode,
  DialogueInput,
  GenerativeAssetKind,
  GenerativeProviderName,
} from "./types";

const MAX_PREFLIGHT_ITERATIONS = 3;

const issueSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    severity: { type: "string", enum: ["low", "medium", "high"] },
    area: {
      type: "string",
      enum: [
        "story",
        "clarity",
        "accuracy",
        "visual_feasibility",
        "safety",
        "provider_fit",
        "asset_continuity",
      ],
    },
    issue: { type: "string" },
    recommendation: { type: "string" },
  },
  required: ["severity", "area", "issue", "recommendation"],
};

const preflightSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    issues: { type: "array", items: issueSchema },
    revisedPrompt: { type: "string" },
    revisedDescription: { type: "string" },
    revisedDialogueInputs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "number" },
          text: { type: "string" },
        },
        required: ["index", "text"],
      },
    },
  },
  required: [
    "summary",
    "issues",
    "revisedPrompt",
    "revisedDescription",
    "revisedDialogueInputs",
  ],
};

function clampIterations(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(MAX_PREFLIGHT_ITERATIONS, Math.floor(parsed)));
}

function planForPrompt(plan?: EditPlan | null): string {
  if (!plan) return "No storyboard/edit plan has been generated yet.";
  return [
    `target length: ${plan.targetLengthSec}s`,
    `style: ${plan.style}`,
    `aspect ratio: ${plan.aspectRatio}`,
    "beats:",
    ...plan.beats.map(
      (beat) => `- ${beat.name} (~${beat.durationSec}s): ${beat.intent}`
    ),
  ].join("\n");
}

function assetCatalogForPrompt(clips: Clip[]): string {
  if (clips.length === 0) return "No existing assets.";
  return clips
    .map(
      (clip) =>
        `- ${clip.id}: ${clip.kind || "video"} | ${clip.filename} | ${
          clip.description || "no description"
        }`
    )
    .join("\n");
}

function dialogueForPrompt(dialogueInputs?: DialogueInput[]): string {
  const lines = dialogueInputs
    ?.map((line, index) => `${index}: ${line.text}`)
    .filter((line) => line.trim());
  return lines?.length ? lines.join("\n") : "No dialogue inputs.";
}

export interface PreflightGenerationContentInput {
  provider: GenerativeProviderName;
  kind: GenerativeAssetKind;
  prompt: string;
  description: string;
  iterations?: unknown;
  script?: string;
  storyboard?: string;
  prompts?: string[];
  dialogueInputs?: DialogueInput[];
  audioMode?: AudioGenerationMode;
  storyContext?: StoryContext | null;
  plan?: EditPlan | null;
  clips?: Clip[];
}

export async function preflightGenerationContent(
  input: PreflightGenerationContentInput
): Promise<GenerationPreflightResult> {
  const requestedIterations = clampIterations(input.iterations);
  let prompt =
    input.prompt.trim() ||
    input.dialogueInputs?.map((line) => line.text).join("\n").trim() ||
    "";
  let description = input.description.trim() || prompt;
  const passes: GenerationPreflightPass[] = [];
  let dialogueInputs = input.dialogueInputs?.map((line) => ({ ...line }));

  if (requestedIterations === 0) {
    return {
      requestedIterations,
      completedIterations: 0,
      originalPrompt: input.prompt,
      finalPrompt: prompt,
      finalDescription: description,
      finalDialogueInputs: dialogueInputs,
      passes,
    };
  }

  const sys = `You are the preflight reviewer for an AI-native video production tool.
Before content is sent to image, video, or audio generation providers, you
review the script, storyboard, prompt, references, and story framework for
issues that could reduce output quality or create inaccurate/unsafe content.

Review against this framework:
- The asset should serve a clear story beat, not just decorate the video.
- It should support a hook, visual reveal, simple model, accurate caveat, or
  payoff where relevant.
- Prompts should be concrete, visually feasible, and provider-ready.
- Flag scientific or factual claims that need careful wording.
- Flag continuity risks with existing assets, characters, style, or tone.
- Flag provider-fit issues such as asking for too many actions in one short
  clip, ambiguous camera motion, impossible text rendering, or vague subjects.

Return JSON only. Keep the revised prompt ready to send directly to the
generation provider. Keep the description short and useful for the asset
library. If dialogue inputs are provided, return revisedDialogueInputs with the
same zero-based indexes and revised text only; do not invent or remove speakers.
If no dialogue inputs are provided, return an empty revisedDialogueInputs array.
For ElevenLabs speech generation, revisedPrompt is the exact text that will be
spoken aloud. Do not put voice directions, pronunciation notes, stage
directions, bracketed instructions, or provider instructions in revisedPrompt.`;

  for (let index = 0; index < requestedIterations; index += 1) {
    const previousFeedback =
      passes.length === 0
        ? "No previous preflight pass."
        : passes
            .map(
              (pass) =>
                `Pass ${pass.iteration}: ${pass.summary}\nIssues:\n${pass.issues
                  .map(
                    (issue) =>
                      `- [${issue.severity}/${issue.area}] ${issue.issue} Recommendation: ${issue.recommendation}`
                  )
                  .join("\n")}`
            )
            .join("\n\n");

    const out = await structuredCall<{
      summary: string;
      issues: GenerationPreflightIssue[];
      revisedPrompt: string;
      revisedDescription: string;
      revisedDialogueInputs: { index: number; text: string }[];
    }>({
      cachedSystem: sys,
      user: `Generation target:
provider: ${input.provider}
kind: ${input.kind}
audio mode: ${input.audioMode || "n/a"}

Current prompt:
${prompt}

Current library description:
${description}

Dialogue inputs by zero-based index:
${dialogueForPrompt(dialogueInputs)}

Script or creative goal:
${input.script || "Not provided."}

Storyboard / edit plan:
${input.storyboard || planForPrompt(input.plan)}

Additional prompts:
${(input.prompts || []).length ? input.prompts!.join("\n---\n") : "None."}

Story framework:
${storyContextForPrompt(input.storyContext)}

Existing asset catalog:
${assetCatalogForPrompt(input.clips || [])}

Previous feedback:
${previousFeedback}

Review this content for possible issues. Then update the prompt and description
to address the issues while preserving the creative intent.`,
      schema: preflightSchema,
      maxTokens: 4000,
    });

    prompt = out.revisedPrompt.trim() || prompt;
    description = out.revisedDescription.trim() || description;
    if (dialogueInputs?.length && out.revisedDialogueInputs.length) {
      dialogueInputs = dialogueInputs.map((line, lineIndex) => {
        const revised = out.revisedDialogueInputs.find(
          (candidate) => candidate.index === lineIndex
        );
        return revised?.text?.trim()
          ? { ...line, text: revised.text.trim() }
          : line;
      });
      prompt = dialogueInputs.map((line) => line.text).join("\n");
    }
    passes.push({
      iteration: index + 1,
      summary: out.summary,
      issues: out.issues,
      revisedPrompt: prompt,
      revisedDescription: description,
      revisedDialogueInputs: out.revisedDialogueInputs,
    });
  }

  return {
    requestedIterations,
    completedIterations: passes.length,
    originalPrompt: input.prompt,
    finalPrompt: prompt,
    finalDescription: description,
    finalDialogueInputs: dialogueInputs,
    passes,
  };
}
