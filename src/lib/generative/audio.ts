import {
  DialogueInput,
  GenerateAssetRequest,
  GeneratedAssetResult,
} from "./types";
import { estimateCostUsd } from "./pricing";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_AUDIO_FORMAT = "mp3_44100_128";

type ElevenLabsAudioBody = Record<string, unknown>;

interface ElevenLabsAudioRequest {
  pathName: string;
  body: ElevenLabsAudioBody;
  outputFormat?: string;
}

interface ElevenLabsAudioResultInput {
  bytes: Buffer;
  outputFormat?: string;
  model: string;
  prompt: string;
  requestedSeconds?: number;
}

function requireElevenLabsKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY is not set for the ElevenLabs provider.");
  }
  return key;
}

function audioExtension(outputFormat = DEFAULT_AUDIO_FORMAT): string {
  const codec = outputFormat.split("_")[0]?.toLowerCase();
  if (codec === "wav") return "wav";
  if (codec === "pcm") return "pcm";
  if (codec === "opus") return "opus";
  if (codec === "ulaw" || codec === "alaw") return "raw";
  return "mp3";
}

function audioMimeType(outputFormat = DEFAULT_AUDIO_FORMAT): string {
  const extension = audioExtension(outputFormat);
  if (extension === "wav") return "audio/wav";
  if (extension === "pcm" || extension === "raw") return "application/octet-stream";
  if (extension === "opus") return "audio/opus";
  return "audio/mpeg";
}

function measuredAudioDurationSec(
  bytes: Buffer,
  outputFormat = DEFAULT_AUDIO_FORMAT
): number | undefined {
  return audioExtension(outputFormat) === "mp3"
    ? estimateMp3DurationSec(bytes)
    : undefined;
}

function elevenLabsAudioResult({
  bytes,
  outputFormat,
  model,
  prompt,
  requestedSeconds,
}: ElevenLabsAudioResultInput): GeneratedAssetResult {
  const durationSec = measuredAudioDurationSec(bytes, outputFormat);
  return {
    kind: "audio",
    bytes,
    extension: audioExtension(outputFormat),
    mimeType: audioMimeType(outputFormat),
    provider: "elevenlabs",
    model,
    prompt,
    durationSec,
    costUsd: estimateCostUsd({
      provider: "elevenlabs",
      kind: "audio",
      model,
      durationSec: durationSec ?? requestedSeconds,
    }),
  };
}

const MP3_BITRATES: Record<number, number[]> = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

export function estimateMp3DurationSec(bytes: Buffer): number | undefined {
  let offset = 0;
  if (bytes.slice(0, 3).toString("ascii") === "ID3" && bytes.length >= 10) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    offset = 10 + size;
  }

  let samples = 0;
  let sampleRate = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const versionBits = (bytes[offset + 1] >> 3) & 0x03;
    const layerBits = (bytes[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    if (
      versionBits === 1 ||
      layerBits !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      sampleRateIndex === 3
    ) {
      offset += 1;
      continue;
    }

    const bitrateKbps = MP3_BITRATES[versionBits]?.[bitrateIndex];
    const frameSampleRate = MP3_SAMPLE_RATES[versionBits]?.[sampleRateIndex];
    if (!bitrateKbps || !frameSampleRate) {
      offset += 1;
      continue;
    }

    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const frameLength =
      versionBits === 3
        ? Math.floor((144000 * bitrateKbps) / frameSampleRate + padding)
        : Math.floor((72000 * bitrateKbps) / frameSampleRate + padding);
    if (frameLength <= 4) {
      offset += 1;
      continue;
    }

    sampleRate = frameSampleRate;
    samples += samplesPerFrame;
    offset += frameLength;
  }

  return samples > 0 && sampleRate > 0 ? samples / sampleRate : undefined;
}

function withOutputFormat(pathName: string, outputFormat?: string): string {
  const format = outputFormat || DEFAULT_AUDIO_FORMAT;
  return `${pathName}?output_format=${encodeURIComponent(format)}`;
}

async function elevenLabsAudioFetch({
  pathName,
  body,
  outputFormat,
}: ElevenLabsAudioRequest): Promise<Buffer> {
  const key = requireElevenLabsKey();
  const res = await fetch(
    `${ELEVENLABS_BASE_URL}${withOutputFormat(pathName, outputFormat)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": key,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `ElevenLabs request failed (${res.status}): ${text.slice(0, 500)}`
    );
  }

  return Buffer.from(await res.arrayBuffer());
}

export async function createSpeechAudio(
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  const text = stripSpeechDirectives(input.prompt);
  if (!text) throw new Error("Text is required for speech generation.");

  const model = input.model || "eleven_multilingual_v2";
  const voiceId =
    input.voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const outputFormat = input.outputFormat || DEFAULT_AUDIO_FORMAT;
  const body: ElevenLabsAudioBody = {
    text,
    model_id: model,
    ...(input.languageCode ? { language_code: input.languageCode } : {}),
  };

  const bytes = await elevenLabsAudioFetch({
    pathName: `/text-to-speech/${voiceId}`,
    body,
    outputFormat,
  });

  return elevenLabsAudioResult({
    bytes,
    outputFormat,
    model,
    prompt: text,
    requestedSeconds: input.seconds,
  });
}

export function stripSpeechDirectives(value: string): string {
  let text = value.trim();
  let previous = "";

  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(
        /^\[(?:voice|delivery|narration|tts|elevenlabs|pronunciation|direction|instructions?)[^\]]*\]\s*/i,
        ""
      )
      .replace(
        /^(?:voice|delivery|narration|tts|elevenlabs|pronunciation|direction|instructions?)\s*(?:direction|directions|instructions|notes?)?\s*:\s*[^\n]*(?:\n\s*)+/i,
        ""
      )
      .trim();
  }

  return text;
}

export async function createDialogueAudio(
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  const dialogueInputs = normalizeDialogueInputs(input);
  const model = input.model || "eleven_v3";
  const outputFormat = input.outputFormat || DEFAULT_AUDIO_FORMAT;

  const bytes = await elevenLabsAudioFetch({
    pathName: "/text-to-dialogue",
    body: {
      inputs: dialogueInputs.map((line) => ({
        text: line.text,
        voice_id: line.voiceId,
      })),
      model_id: model,
      ...(input.languageCode ? { language_code: input.languageCode } : {}),
    },
    outputFormat,
  });

  return elevenLabsAudioResult({
    bytes,
    outputFormat,
    model,
    prompt: dialogueInputs.map((line) => line.text).join("\n"),
    requestedSeconds: input.seconds,
  });
}

export async function createSoundEffectAudio(
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  const text = input.prompt.trim();
  if (!text) throw new Error("Text is required for sound effect generation.");

  const model = input.model || "eleven_text_to_sound_v2";
  const outputFormat = input.outputFormat || DEFAULT_AUDIO_FORMAT;
  const body: ElevenLabsAudioBody = {
    text,
    model_id: model,
    ...(typeof input.loop === "boolean" ? { loop: input.loop } : {}),
    ...(input.seconds ? { duration_seconds: input.seconds } : {}),
    ...(typeof input.promptInfluence === "number"
      ? { prompt_influence: input.promptInfluence }
      : {}),
  };

  const bytes = await elevenLabsAudioFetch({
    pathName: "/sound-generation",
    body,
    outputFormat,
  });

  return elevenLabsAudioResult({
    bytes,
    outputFormat,
    model,
    prompt: text,
    requestedSeconds: input.seconds,
  });
}

export async function createMusicAudio(
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required for music generation.");

  const model = input.model || "music_v1";
  const outputFormat = input.outputFormat || DEFAULT_AUDIO_FORMAT;
  const body: ElevenLabsAudioBody = {
    prompt,
    model_id: model,
    ...(input.seconds
      ? { music_length_ms: Math.round(input.seconds * 1000) }
      : {}),
    ...(typeof input.forceInstrumental === "boolean"
      ? { force_instrumental: input.forceInstrumental }
      : {}),
  };

  const bytes = await elevenLabsAudioFetch({
    pathName: "/music",
    body,
    outputFormat,
  });

  return elevenLabsAudioResult({
    bytes,
    outputFormat,
    model,
    prompt,
    requestedSeconds: input.seconds,
  });
}

export async function createElevenLabsAudio(
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  switch (input.audioMode || "speech") {
    case "dialogue":
      return createDialogueAudio(input);
    case "sound_effect":
      return createSoundEffectAudio(input);
    case "music":
      return createMusicAudio(input);
    case "speech":
    default:
      return createSpeechAudio(input);
  }
}

function normalizeDialogueInputs(input: GenerateAssetRequest): DialogueInput[] {
  const fromBody = input.dialogueInputs?.filter(
    (line) => line.text.trim() && line.voiceId.trim()
  );
  if (fromBody?.length) return fromBody;

  const voiceId =
    input.voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const text = input.prompt.trim();
  if (!text) throw new Error("Dialogue inputs or prompt text are required.");
  return [{ text, voiceId }];
}
