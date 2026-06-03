// Hand-written JSON Schemas for output_config.format. Kept here so every agent
// shares the exact patch shape the timeline engine knows how to apply.

const num = { type: "number" } as const;
const str = { type: "string" } as const;

export const planSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    targetLengthSec: num,
    style: str,
    aspectRatio: { type: "string", enum: ["9:16", "16:9", "1:1"] },
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: str,
          durationSec: num,
          intent: str,
        },
        required: ["name", "durationSec", "intent"],
      },
    },
  },
  required: ["targetLengthSec", "style", "aspectRatio", "beats"],
};

const planCritiqueIssueSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    severity: { type: "string", enum: ["low", "medium", "high"] },
    area: {
      type: "string",
      enum: [
        "story_arc",
        "beat_order",
        "character_continuity",
        "prompt_specificity",
        "visual_feasibility",
        "timing",
      ],
    },
    issue: str,
    recommendation: str,
  },
  required: ["severity", "area", "issue", "recommendation"],
};

export const planCritiqueSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    storyArc: { type: "string", enum: ["pass", "needs_review", "fail"] },
    characterContinuity: {
      type: "string",
      enum: ["pass", "needs_review", "fail"],
    },
    promptReadiness: { type: "string", enum: ["pass", "needs_review", "fail"] },
    visualFeasibility: {
      type: "string",
      enum: ["pass", "needs_review", "fail"],
    },
    summary: str,
    issues: { type: "array", items: planCritiqueIssueSchema },
    revisedPlan: planSchema,
  },
  required: [
    "storyArc",
    "characterContinuity",
    "promptReadiness",
    "visualFeasibility",
    "summary",
    "issues",
    "revisedPlan",
  ],
};

export const uploadedFootagePlanReviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    storyArc: { type: "string", enum: ["pass", "needs_review", "fail"] },
    sourceCoverage: { type: "string", enum: ["pass", "needs_review", "fail"] },
    timing: { type: "string", enum: ["pass", "needs_review", "fail"] },
    missingBeats: { type: "array", items: str },
    recommendedMode: {
      type: "string",
      enum: ["uploaded_only", "hybrid_generate_gaps", "needs_more_source"],
    },
    summary: str,
    revisedPlan: planSchema,
  },
  required: [
    "storyArc",
    "sourceCoverage",
    "timing",
    "missingBeats",
    "recommendedMode",
    "summary",
    "revisedPlan",
  ],
};

export const compositionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: str,
          intent: str,
          durationSec: num,
          assetStrategy: {
            type: "string",
            enum: ["use_existing", "generate_image", "generate_video"],
          },
          requiredAssetIds: { type: "array", items: str },
          generationKind: { type: "string", enum: ["image", "video"] },
          generationPrompt: str,
        },
        required: ["name", "intent", "durationSec", "assetStrategy"],
      },
    },
    narration: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["none", "provided", "generate"] },
        script: str,
      },
      required: ["mode"],
    },
  },
  required: ["beats", "narration"],
};

export const timelineSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    showCaptions: { type: "boolean" },
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          clipId: str,
          sourceInSec: num,
          sourceOutSec: num,
          role: str,
          reason: str,
          caption: str,
        },
        required: ["clipId", "sourceInSec", "sourceOutSec", "role", "reason"],
      },
    },
  },
  required: ["segments"],
};

export const editDecisionTimelineSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    showCaptions: { type: "boolean" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          beatId: str,
          clipId: str,
          sourceInSec: num,
          sourceOutSec: num,
          rationale: str,
          caption: str,
        },
        required: ["beatId", "clipId", "sourceInSec", "sourceOutSec", "rationale"],
      },
    },
  },
  required: ["decisions"],
};

const patchSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["replace_clip"] },
        segmentId: str,
        newClipId: str,
        sourceInSec: num,
        sourceOutSec: num,
        reason: str,
      },
      required: ["op", "segmentId", "newClipId", "sourceInSec", "sourceOutSec", "reason"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["set_trim"] },
        segmentId: str,
        sourceInSec: num,
        sourceOutSec: num,
        reason: str,
      },
      required: ["op", "segmentId", "sourceInSec", "sourceOutSec", "reason"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["remove_segment"] },
        segmentId: str,
        reason: str,
      },
      required: ["op", "segmentId", "reason"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["reorder"] },
        segmentIdsInOrder: { type: "array", items: str },
        reason: str,
      },
      required: ["op", "segmentIdsInOrder", "reason"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["add_segment"] },
        clipId: str,
        sourceInSec: num,
        sourceOutSec: num,
        role: str,
        afterSegmentId: { type: ["string", "null"] },
        reason: str,
      },
      required: ["op", "clipId", "sourceInSec", "sourceOutSec", "role", "afterSegmentId", "reason"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["set_caption"] },
        segmentId: str,
        caption: str,
        reason: str,
      },
      required: ["op", "segmentId", "caption", "reason"],
    },
  ],
};

export const criticSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      properties: {
        hook_score: num,
        clarity_score: num,
        pacing_score: num,
        visual_variety: num,
        script_coverage: num,
        emotional_arc: num,
        repetition_penalty: num,
      },
      required: [
        "hook_score",
        "clarity_score",
        "pacing_score",
        "visual_variety",
        "script_coverage",
        "emotional_arc",
        "repetition_penalty",
      ],
    },
    summary: str,
    patches: { type: "array", items: patchSchema },
  },
  required: ["scores", "summary", "patches"],
};

export const reviseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: str,
    patches: { type: "array", items: patchSchema },
  },
  required: ["summary", "patches"],
};

export const narrationRewriteSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    script: str,
    estimatedDurationSec: num,
    summary: str,
  },
  required: ["script", "estimatedDurationSec", "summary"],
};
