import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const API_BASE_URL = trimTrailingSlash(
  process.env.VIDEO_GENERATION_SMOKE_API_URL || "http://127.0.0.1:3000"
);
const PROMPT =
  process.env.VIDEO_GENERATION_SMOKE_PROMPT ||
  "A drone flies slowly through a clean industrial warehouse.";
const OUTPUT_PATH = resolve(
  process.env.VIDEO_GENERATION_SMOKE_OUTPUT ||
    "artifacts/video-generation/cosmos3-nano-smoke.mp4"
);

async function main() {
  console.log(
    JSON.stringify({
      event: "video_generation_smoke_started",
      apiBaseUrl: API_BASE_URL,
      outputPath: OUTPUT_PATH,
    })
  );

  const response = await fetch(`${API_BASE_URL}/api/v1/video-generation/videos`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      prompt: PROMPT,
      resolution: process.env.VIDEO_GENERATION_SMOKE_RESOLUTION || "480_16_9",
      frameCount: Number(process.env.VIDEO_GENERATION_SMOKE_FRAME_COUNT || "24"),
      seed: Number(process.env.VIDEO_GENERATION_SMOKE_SEED || "42"),
    }),
  });

  const body = (await response.json().catch(() => ({}))) as SmokeResponse;
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "video_generation_smoke_failed",
        status: response.status,
        error: body.error || body,
      })
    );
    process.exit(1);
  }

  const b64Video = body.video?.b64Video;
  if (!b64Video) {
    console.error(
      JSON.stringify({
        event: "video_generation_smoke_failed",
        reason: "missing_b64_video",
        body,
      })
    );
    process.exit(1);
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  const bytes = Buffer.from(stripDataUriPrefix(b64Video), "base64");
  await writeFile(OUTPUT_PATH, bytes);

  console.log(
    JSON.stringify({
      event: "video_generation_smoke_passed",
      provider: body.video?.provider,
      model: body.video?.model,
      outputPath: OUTPUT_PATH,
      bytes: bytes.byteLength,
    })
  );
}

type SmokeResponse = {
  video?: {
    provider?: string;
    model?: string;
    b64Video?: string;
  };
  error?: unknown;
};

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function stripDataUriPrefix(value: string) {
  const marker = ";base64,";
  const index = value.indexOf(marker);
  return index === -1 ? value : value.slice(index + marker.length);
}

void main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "video_generation_smoke_failed",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
