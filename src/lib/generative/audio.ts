import {
  DialogueInput,
  GenerateAssetRequest,
  GeneratedAssetResult,
} from "./types";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_AUDIO_FORMAT = "mp3_44100_128";

type ElevenLabsAudioBody = Record<string, unknown>;

interface ElevenLabsAudioRequest {
  pathName: string;
  body: ElevenLabsAudioBody;
  outputFormat?: string;
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
  const text = input.prompt.trim();
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

  return {
    kind: "audio",
    bytes: await elevenLabsAudioFetch({
      pathName: `/text-to-speech/${voiceId}`,
      body,
      outputFormat,
    }),
    extension: audioExtension(outputFormat),
    mimeType: audioMimeType(outputFormat),
    provider: "elevenlabs",
    model,
    prompt: text,
  };
}

export async function createDialogueAudio(
  input: GenerateAssetRequest
): Promise<GeneratedAssetResult> {
  const dialogueInputs = normalizeDialogueInputs(input);
  const model = input.model || "eleven_v3";
  const outputFormat = input.outputFormat || DEFAULT_AUDIO_FORMAT;

  return {
    kind: "audio",
    bytes: await elevenLabsAudioFetch({
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
    }),
    extension: audioExtension(outputFormat),
    mimeType: audioMimeType(outputFormat),
    provider: "elevenlabs",
    model,
    prompt: dialogueInputs.map((line) => line.text).join("\n"),
  };
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

  return {
    kind: "audio",
    bytes: await elevenLabsAudioFetch({
      pathName: "/sound-generation",
      body,
      outputFormat,
    }),
    extension: audioExtension(outputFormat),
    mimeType: audioMimeType(outputFormat),
    provider: "elevenlabs",
    model,
    prompt: text,
  };
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

  return {
    kind: "audio",
    bytes: await elevenLabsAudioFetch({
      pathName: "/music",
      body,
      outputFormat,
    }),
    extension: audioExtension(outputFormat),
    mimeType: audioMimeType(outputFormat),
    provider: "elevenlabs",
    model,
    prompt,
  };
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
