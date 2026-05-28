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

export const timelineSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
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
