export const EDIT_GRAPH_SCHEMA = {
  semanticAnalysis: "semanticAnalysis.v1",
  editDecision: "editDecision.v1",
} as const;

export type SceneType =
  | "talking_head"
  | "b_roll"
  | "screen_recording"
  | "product_shot"
  | "title_card";

export interface WordTiming {
  id: string;
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface TranscriptSpan {
  id: string;
  assetId: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
  text: string;
  words: WordTiming[];
}

export interface MediaSegment {
  id: string;
  assetId: string;
  startMs: number;
  endMs: number;
  transcriptSpanIds: string[];
  visualDescription?: string;
  detectedObjects?: string[];
  sceneType?: SceneType;
  audioFeatures?: {
    energy: number;
    silence: boolean;
    music?: boolean;
    speech?: boolean;
  };
  qualitySignals?: {
    sharpness?: number;
    exposure?: number;
    audioClarity?: number;
    faceVisible?: boolean;
    cameraMotion?: "static" | "smooth" | "shaky";
  };
  semanticTags: string[];
}

export interface SemanticAnalysis {
  schemaVersion: typeof EDIT_GRAPH_SCHEMA.semanticAnalysis;
  assetId: string;
  transcript: TranscriptSpan[];
  segments: MediaSegment[];
  createdAt: string;
}

export type TextEditOperation =
  | {
      type: "remove_words";
      wordIds: string[];
      reason?: string;
    }
  | {
      type: "compress_pause";
      transcriptSpanIds: string[];
      targetPauseMs: number;
      reason?: string;
    }
  | {
      type: "reorder_sentence";
      transcriptSpanIds: string[];
      insertAfterSpanId?: string;
      reason?: string;
    }
  | {
      type: "bleep";
      wordIds: string[];
      reason?: string;
    }
  | {
      type: "caption_emphasis";
      wordIds: string[];
      style?: "highlight" | "underline" | "bold";
      reason?: string;
    };

export type EditDecisionOperation =
  | "select_segment"
  | "trim"
  | "cut"
  | "insert_broll"
  | "overlay"
  | "transition"
  | "caption"
  | "music"
  | "sound_effect"
  | "effect"
  | "remove_silence";

export interface EditDecision {
  id: string;
  schemaVersion: typeof EDIT_GRAPH_SCHEMA.editDecision;
  beatId: string;
  operation: EditDecisionOperation;
  sourceSegmentIds: string[];
  rationale?: string;
  constraints?: {
    minDurationMs?: number;
    maxDurationMs?: number;
    mustIncludeWords?: string[];
    avoidJumpCut?: boolean;
    preserveSpeakerContinuity?: boolean;
  };
  textEdit?: TextEditOperation;
  confidence?: number;
}
