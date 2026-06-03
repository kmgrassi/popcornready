import {
  EDIT_GRAPH_PROJECT_SCHEMA_VERSION,
  EDIT_GRAPH_SCHEMA_VERSION,
} from "./types";

const bool = { type: "boolean" } as const;
const num = { type: "number" } as const;
const str = { type: "string" } as const;
const strArray = { type: "array", items: str } as const;

const optionalNumberObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    width: num,
    height: num,
    fps: num,
    sampleRate: num,
    channels: num,
    codec: str,
  },
} as const;

const generatedMediaProvenanceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: str,
    model: str,
    prompt: str,
  },
  required: ["provider", "prompt"],
} as const;

const wordTimingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    word: str,
    startMs: num,
    endMs: num,
    confidence: num,
  },
  required: ["word", "startMs", "endMs", "confidence"],
} as const;

const transcriptSpanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    assetId: str,
    startMs: num,
    endMs: num,
    speakerId: str,
    text: str,
    words: { type: "array", items: wordTimingSchema },
  },
  required: ["id", "assetId", "startMs", "endMs", "text", "words"],
} as const;

const mediaSegmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    assetId: str,
    startMs: num,
    endMs: num,
    transcript: { type: "array", items: transcriptSpanSchema },
    visualDescription: str,
    detectedObjects: strArray,
    sceneType: {
      type: "string",
      enum: [
        "talking_head",
        "b_roll",
        "screen_recording",
        "product_shot",
        "title_card",
      ],
    },
    audioFeatures: {
      type: "object",
      additionalProperties: false,
      properties: {
        energy: num,
        silence: bool,
        music: bool,
        speech: bool,
      },
      required: ["energy", "silence"],
    },
    qualitySignals: {
      type: "object",
      additionalProperties: false,
      properties: {
        sharpness: num,
        exposure: num,
        audioClarity: num,
        faceVisible: bool,
        cameraMotion: { type: "string", enum: ["static", "smooth", "shaky"] },
      },
    },
    semanticTags: strArray,
  },
  required: ["id", "assetId", "startMs", "endMs", "semanticTags"],
} as const;

const storyBeatSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    role: {
      type: "string",
      enum: [
        "hook",
        "context",
        "problem",
        "setup",
        "demo",
        "evidence",
        "contrast",
        "payoff",
        "cta",
        "outro",
      ],
    },
    intent: str,
    targetDurationMs: num,
    requiredContent: {
      type: "object",
      additionalProperties: false,
      properties: {
        transcriptMeaning: str,
        visualTags: strArray,
        speaker: str,
      },
    },
    emotionalShape: {
      type: "object",
      additionalProperties: false,
      properties: {
        energy: { type: "string", enum: ["low", "medium", "high"] },
        sentiment: {
          type: "string",
          enum: ["neutral", "positive", "tense", "excited"],
        },
      },
      required: ["energy", "sentiment"],
    },
  },
  required: ["id", "role", "intent"],
} as const;

const editDecisionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    beatId: str,
    operation: {
      type: "string",
      enum: [
        "select_segment",
        "trim",
        "cut",
        "insert_broll",
        "overlay",
        "transition",
        "caption",
        "music",
        "sound_effect",
        "effect",
        "remove_silence",
      ],
    },
    sourceSegmentIds: strArray,
    rationale: str,
    constraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        minDurationMs: num,
        maxDurationMs: num,
        mustIncludeWords: strArray,
        avoidJumpCut: bool,
        preserveSpeakerContinuity: bool,
      },
    },
    confidence: num,
  },
  required: ["id", "beatId", "operation", "sourceSegmentIds"],
} as const;

const transitionAlternativeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [
        "hard_cut",
        "jump_cut",
        "match_cut",
        "crossfade",
        "audio_lead_in",
        "audio_trail_out",
        "smash_cut",
        "scene_change",
        "hidden_cut",
      ],
    },
    cutAtMs: num,
    score: num,
  },
  required: ["type", "cutAtMs", "score"],
} as const;

const transitionDecisionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    fromBeatId: str,
    toBeatId: str,
    type: transitionAlternativeSchema.properties.type,
    timing: {
      type: "object",
      additionalProperties: false,
      properties: {
        cutAtMs: num,
        preRollMs: num,
        postRollMs: num,
      },
      required: ["cutAtMs"],
    },
    reason: {
      type: "string",
      enum: [
        "sentence_boundary",
        "beat_change",
        "visual_match",
        "music_downbeat",
        "motion_continuity",
        "emotional_shift",
        "remove_dead_air",
        "hide_jump_cut",
      ],
    },
    confidence: num,
    alternatives: { type: "array", items: transitionAlternativeSchema },
  },
  required: ["id", "fromBeatId", "toBeatId", "type", "timing", "reason", "confidence"],
} as const;

const overlaySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    role: {
      type: "string",
      enum: [
        "caption",
        "lower_third",
        "logo",
        "callout",
        "highlight",
        "annotation",
        "diagram",
        "subtitle",
        "reaction",
        "comparison",
      ],
    },
    intent: str,
    anchor: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["timeline_time"] },
            refId: str,
            offsetMs: num,
          },
          required: ["type"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["spoken_phrase"] },
            refId: str,
            phrase: str,
            offsetMs: num,
          },
          required: ["type", "phrase"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["object"] },
            refId: str,
            offsetMs: num,
          },
          required: ["type"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["person"] },
            refId: str,
            offsetMs: num,
          },
          required: ["type"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["beat"] },
            refId: str,
            offsetMs: num,
          },
          required: ["type", "refId"],
        },
      ],
    },
    layout: {
      type: "object",
      additionalProperties: false,
      properties: {
        region: {
          type: "string",
          enum: ["top", "bottom", "left", "right", "center", "custom"],
        },
        avoidFaces: bool,
        avoidSubtitles: bool,
        safeArea: bool,
      },
      required: ["region"],
    },
    content: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: { type: { type: "string", enum: ["text"] }, text: str },
          required: ["type", "text"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { type: { type: "string", enum: ["image"] }, assetId: str },
          required: ["type", "assetId"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { type: { type: "string", enum: ["shape"] }, shape: str },
          required: ["type", "shape"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { type: { type: "string", enum: ["generated"] }, prompt: str },
          required: ["type", "prompt"],
        },
      ],
    },
    style: {
      type: "object",
      additionalProperties: false,
      properties: { id: str, name: str },
      required: ["id"],
    },
  },
  required: ["id", "role", "intent", "anchor", "layout", "content"],
} as const;

const timelineItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: str,
    source: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["media"] },
            assetId: str,
            sourceStartMs: num,
            sourceEndMs: num,
          },
          required: ["kind", "assetId", "sourceStartMs", "sourceEndMs"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["generated_text"] },
            text: str,
          },
          required: ["kind", "text"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["generated_image"] },
            assetId: str,
          },
          required: ["kind", "assetId"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { type: "string", enum: ["effect"] } },
          required: ["kind"],
        },
      ],
    },
    timelineStartMs: num,
    timelineEndMs: num,
    transform: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: num,
        y: num,
        scale: num,
        rotation: num,
        opacity: num,
      },
      required: ["x", "y", "scale", "rotation", "opacity"],
    },
    effects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: { id: str, type: str },
        required: ["id", "type"],
      },
    },
  },
  required: ["id", "source", "timelineStartMs", "timelineEndMs"],
} as const;

export const editGraphSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: {
      type: "string",
      enum: [EDIT_GRAPH_SCHEMA_VERSION],
    },
    decisions: { type: "array", items: editDecisionSchema },
    transitions: { type: "array", items: transitionDecisionSchema },
    overlays: { type: "array", items: overlaySchema },
    constraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDurationMs: num,
        minDurationMs: num,
        requiredBeats: strArray,
        forbiddenContent: strArray,
        preserveChronology: bool,
        allowGeneratedMedia: bool,
        allowVoiceover: bool,
        allowMusic: bool,
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        pacing: { type: "string", enum: ["fast", "balanced", "slow"] },
        transitionStyle: {
          type: "string",
          enum: ["invisible", "energetic", "cinematic"],
        },
        tolerateJumpCuts: bool,
        preferMusicSync: bool,
      },
      required: [
        "pacing",
        "transitionStyle",
        "tolerateJumpCuts",
        "preferMusicSync",
      ],
    },
    candidateCuts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          atMs: num,
          score: num,
          features: {
            type: "object",
            additionalProperties: false,
            properties: {
              sentenceBoundary: bool,
              silenceBeforeMs: num,
              silenceAfterMs: num,
              visualMotionContinuity: num,
              musicBeatAlignment: num,
              facePoseChange: num,
              semanticShift: num,
            },
            required: [
              "sentenceBoundary",
              "silenceBeforeMs",
              "silenceAfterMs",
              "visualMotionContinuity",
              "musicBeatAlignment",
              "facePoseChange",
              "semanticShift",
            ],
          },
        },
        required: ["atMs", "score", "features"],
      },
    },
  },
  required: ["schemaVersion", "decisions", "transitions", "overlays", "constraints"],
} as const;

export const aiVideoProjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: {
      type: "string",
      enum: [EDIT_GRAPH_PROJECT_SCHEMA_VERSION],
    },
    id: str,
    assets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: str,
          uri: str,
          type: {
            type: "string",
            enum: ["video", "audio", "image", "text", "generated"],
          },
          durationMs: num,
          metadata: optionalNumberObject,
          generatedBy: generatedMediaProvenanceSchema,
        },
        required: ["id", "uri", "type", "metadata"],
      },
    },
    analysis: {
      type: "object",
      additionalProperties: false,
      properties: {
        segments: { type: "array", items: mediaSegmentSchema },
        transcript: { type: "array", items: transcriptSpanSchema },
        visualEntities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: str,
              assetId: str,
              segmentId: str,
              label: str,
              confidence: num,
              startMs: num,
              endMs: num,
            },
            required: ["id", "assetId", "label"],
          },
        },
        audioEvents: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: str,
              assetId: str,
              segmentId: str,
              type: {
                type: "string",
                enum: ["speech", "silence", "music", "sfx", "noise"],
              },
              startMs: num,
              endMs: num,
              confidence: num,
            },
            required: ["id", "assetId", "type", "startMs", "endMs"],
          },
        },
        embeddings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: str,
              ownerId: str,
              ownerType: {
                type: "string",
                enum: ["asset", "segment", "transcript_span", "beat"],
              },
              model: str,
              vectorRef: str,
            },
            required: ["id", "ownerId", "ownerType", "model", "vectorRef"],
          },
        },
      },
      required: ["segments", "transcript", "visualEntities", "audioEvents", "embeddings"],
    },
    intent: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: str,
        audience: str,
        platform: {
          type: "string",
          enum: ["youtube", "tiktok", "instagram", "x", "linkedin", "internal"],
        },
        targetDurationMs: num,
        aspectRatio: { type: "string", enum: ["9:16", "16:9", "1:1", "4:5"] },
        tone: str,
        styleRefs: strArray,
      },
      required: ["goal"],
    },
    story: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: str,
        objective: str,
        targetDurationMs: num,
        audience: str,
        tone: {
          type: "string",
          enum: ["educational", "funny", "cinematic", "salesy", "documentary"],
        },
        beats: { type: "array", items: storyBeatSchema },
      },
      required: ["id", "objective", "targetDurationMs", "beats"],
    },
    edit: editGraphSchema,
    timeline: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: str,
        fps: num,
        width: num,
        height: num,
        durationMs: num,
        tracks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: str,
              type: { type: "string", enum: ["video", "audio", "text", "effect"] },
              role: {
                type: "string",
                enum: [
                  "primary_video",
                  "b_roll",
                  "voiceover",
                  "music",
                  "captions",
                  "graphics",
                  "sfx",
                ],
              },
              zIndex: num,
              items: { type: "array", items: timelineItemSchema },
            },
            required: ["id", "type", "role", "items"],
          },
        },
      },
      required: ["id", "fps", "width", "height", "durationMs", "tracks"],
    },
    render: {
      type: "object",
      additionalProperties: false,
      properties: {
        engine: {
          type: "string",
          enum: ["ffmpeg", "remotion", "moviepy", "custom_gpu"],
        },
        output: {
          type: "object",
          additionalProperties: false,
          properties: {
            format: { type: "string", enum: ["mp4", "mov", "webm"] },
            codec: { type: "string", enum: ["h264", "h265", "prores"] },
            width: num,
            height: num,
            fps: num,
            bitrate: str,
          },
          required: ["format", "codec", "width", "height", "fps"],
        },
      },
      required: ["engine", "output"],
    },
  },
  required: [
    "schemaVersion",
    "id",
    "assets",
    "analysis",
    "intent",
    "story",
    "edit",
    "timeline",
    "render",
  ],
} as const;
