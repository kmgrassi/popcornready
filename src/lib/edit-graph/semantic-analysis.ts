import {
  EDIT_GRAPH_SCHEMA,
  EditDecision,
  MediaSegment,
  SemanticAnalysis,
  TextEditOperation,
  TranscriptSpan,
  WordTiming,
} from "./types";

export interface SemanticAssetInput {
  id: string;
  kind: "video" | "image" | "audio";
  durationSec?: number;
  filename?: string;
  description?: string;
  source?: { type?: string } | string;
  context?: {
    summary?: string;
    recommendedRoles?: string[];
    transcriptText?: string;
    moments?: { startSec: number; endSec: number; label?: string }[];
  };
  provenance?: {
    prompt?: string;
    provider?: string;
    model?: string;
  };
}

interface BuildOptions {
  now?: string;
}

interface TextEditDecisionOptions {
  id?: string;
  beatId?: string;
  rationale?: string;
  confidence?: number;
}

function clampMs(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function durationMsFor(asset: SemanticAssetInput): number {
  if (typeof asset.durationSec === "number" && Number.isFinite(asset.durationSec)) {
    return Math.max(0, Math.round(asset.durationSec * 1000));
  }
  return asset.kind === "image" ? 4000 : 0;
}

function sourceType(asset: SemanticAssetInput): string | undefined {
  if (typeof asset.source === "string") return asset.source;
  return asset.source?.type;
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function tagsFor(asset: SemanticAssetInput): string[] {
  return unique([
    asset.kind,
    sourceType(asset),
    ...(asset.context?.recommendedRoles ?? []),
    ...(asset.provenance?.provider ? ["generated"] : []),
  ]);
}

function wordsFromText(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function transcriptFromText(args: {
  assetId: string;
  text: string;
  durationMs: number;
  spanId?: string;
}): TranscriptSpan[] {
  const words = wordsFromText(args.text);
  if (words.length === 0) return [];

  const durationMs = Math.max(args.durationMs, words.length * 220);
  const wordDurationMs = durationMs / words.length;
  const timings: WordTiming[] = words.map((word, index) => {
    const startMs = Math.round(index * wordDurationMs);
    const endMs =
      index === words.length - 1
        ? durationMs
        : Math.round((index + 1) * wordDurationMs);
    return {
      id: `${args.assetId}_word_${index + 1}`,
      word,
      startMs,
      endMs,
      confidence: 0.6,
    };
  });

  return [
    {
      id: args.spanId ?? `${args.assetId}_span_1`,
      assetId: args.assetId,
      startMs: 0,
      endMs: durationMs,
      text: words.join(" "),
      words: timings,
    },
  ];
}

function transcriptTextFor(asset: SemanticAssetInput): string | undefined {
  return (
    asset.context?.transcriptText ||
    asset.context?.summary ||
    asset.description ||
    asset.provenance?.prompt
  )?.trim();
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function segmentTranscriptIds(
  transcript: TranscriptSpan[],
  startMs: number,
  endMs: number
): string[] {
  return transcript
    .filter((span) => overlaps(span.startMs, span.endMs, startMs, endMs))
    .map((span) => span.id);
}

export function decomposeAssetIntoSegments(
  asset: SemanticAssetInput,
  transcript: TranscriptSpan[]
): MediaSegment[] {
  const durationMs = durationMsFor(asset);
  const tags = tagsFor(asset);
  const moments = asset.context?.moments ?? [];

  if (moments.length > 0) {
    return moments.map((moment, index) => {
      const startMs = clampMs(moment.startSec * 1000, 0, durationMs || Number.MAX_SAFE_INTEGER);
      const endMs = clampMs(
        moment.endSec * 1000,
        startMs,
        durationMs || Number.MAX_SAFE_INTEGER
      );
      return {
        id: `${asset.id}_segment_${index + 1}`,
        assetId: asset.id,
        startMs,
        endMs,
        transcriptSpanIds: segmentTranscriptIds(transcript, startMs, endMs),
        visualDescription: moment.label || asset.context?.summary,
        semanticTags: unique([...tags, moment.label]),
      };
    });
  }

  if (transcript.length > 0) {
    return transcript.map((span, index) => ({
      id: `${asset.id}_segment_${index + 1}`,
      assetId: asset.id,
      startMs: span.startMs,
      endMs: span.endMs,
      transcriptSpanIds: [span.id],
      visualDescription: asset.kind === "audio" ? undefined : asset.context?.summary,
      audioFeatures:
        asset.kind === "audio" || asset.kind === "video"
          ? { energy: 0.5, silence: false, speech: true }
          : undefined,
      semanticTags: tags,
    }));
  }

  return [
    {
      id: `${asset.id}_segment_1`,
      assetId: asset.id,
      startMs: 0,
      endMs: durationMs,
      transcriptSpanIds: [],
      visualDescription: asset.context?.summary || asset.description,
      semanticTags: tags,
    },
  ];
}

export function buildSemanticAnalysis(
  asset: SemanticAssetInput,
  options: BuildOptions = {}
): SemanticAnalysis {
  const durationMs = durationMsFor(asset);
  const text = transcriptTextFor(asset);
  const transcript = text
    ? transcriptFromText({ assetId: asset.id, text, durationMs })
    : [];
  const segments = decomposeAssetIntoSegments(asset, transcript);

  return {
    schemaVersion: EDIT_GRAPH_SCHEMA.semanticAnalysis,
    assetId: asset.id,
    transcript,
    segments,
    createdAt: options.now ?? new Date().toISOString(),
  };
}

function segmentIdsForTextEdit(
  analysis: Pick<SemanticAnalysis, "transcript" | "segments">,
  textEdit: TextEditOperation
): string[] {
  const spanIds = new Set<string>();
  if ("transcriptSpanIds" in textEdit) {
    for (const id of textEdit.transcriptSpanIds) spanIds.add(id);
  }
  if ("wordIds" in textEdit) {
    for (const span of analysis.transcript) {
      if (span.words.some((word) => textEdit.wordIds.includes(word.id))) {
        spanIds.add(span.id);
      }
    }
  }

  return analysis.segments
    .filter((segment) => segment.transcriptSpanIds.some((id) => spanIds.has(id)))
    .map((segment) => segment.id);
}

function decisionOperationFor(textEdit: TextEditOperation): EditDecision["operation"] {
  switch (textEdit.type) {
    case "remove_words":
    case "reorder_sentence":
      return "cut";
    case "compress_pause":
      return "remove_silence";
    case "bleep":
      return "sound_effect";
    case "caption_emphasis":
      return "caption";
  }
}

export function textEditToEditDecision(
  analysis: Pick<SemanticAnalysis, "transcript" | "segments">,
  textEdit: TextEditOperation,
  options: TextEditDecisionOptions = {}
): EditDecision {
  const sourceSegmentIds = segmentIdsForTextEdit(analysis, textEdit);
  const mustIncludeWords =
    "wordIds" in textEdit
      ? analysis.transcript
          .flatMap((span) => span.words)
          .filter((word) => textEdit.wordIds.includes(word.id))
          .map((word) => word.word)
      : undefined;

  return {
    id: options.id ?? `decision_${Math.random().toString(36).slice(2, 10)}`,
    schemaVersion: EDIT_GRAPH_SCHEMA.editDecision,
    beatId: options.beatId ?? "transcript_edit",
    operation: decisionOperationFor(textEdit),
    sourceSegmentIds,
    rationale: options.rationale ?? textEdit.reason,
    ...(mustIncludeWords && mustIncludeWords.length > 0
      ? { constraints: { mustIncludeWords } }
      : {}),
    textEdit,
    confidence: options.confidence ?? 0.8,
  };
}
