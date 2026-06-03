import assert from "node:assert/strict";
import test from "node:test";
import { providerFor } from "../providers";

test("providerFor resolves NVIDIA Cosmos aliases", () => {
  assert.equal(providerFor("nvidia_api_catalog").name, "nvidia_api_catalog");
  assert.equal(providerFor("cosmos3-nano").name, "nvidia_api_catalog");
});

test("NVIDIA Cosmos provider maps video requests to API Catalog payloads", async () => {
  const previousKey = process.env.NVIDIA_API_KEY;
  const previousModel = process.env.NVIDIA_VIDEO_GENERATION_MODEL;
  const previousBaseUrl = process.env.NVIDIA_VIDEO_GENERATION_BASE_URL;
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: any; headers: Headers }> = [];

  process.env.NVIDIA_API_KEY = "test-key";
  process.env.NVIDIA_VIDEO_GENERATION_MODEL = "nvidia/cosmos3-nano";
  process.env.NVIDIA_VIDEO_GENERATION_BASE_URL =
    "https://ai.api.nvidia.com/v1/genai";
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")),
      headers: new Headers(init?.headers),
    });
    return new Response(
      JSON.stringify({
        b64_video: Buffer.from("mp4-bytes").toString("base64"),
        seed: 42,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const result = await providerFor("nvidia").generateAsset({
      provider: "nvidia_api_catalog",
      kind: "video",
      prompt: "A clean product shot.",
      resolution: "480_16_9",
      frameCount: 24,
      seed: 42,
      steps: 8,
      guidanceScale: 3.5,
    });

    assert.equal(result.provider, "nvidia_api_catalog");
    assert.equal(result.model, "nvidia/cosmos3-nano");
    assert.equal(result.mimeType, "video/mp4");
    assert.deepEqual(result.bytes, Buffer.from("mp4-bytes"));
    assert.equal(
      requests[0].url,
      "https://ai.api.nvidia.com/v1/genai/nvidia/cosmos3-nano"
    );
    assert.equal(requests[0].headers.get("authorization"), "Bearer test-key");
    assert.deepEqual(requests[0].body, {
      prompt: "A clean product shot.",
      resolution: "480_16_9",
      num_output_frames: 24,
      seed: 42,
      steps: 8,
      guidance_scale: 3.5,
    });
  } finally {
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.NVIDIA_VIDEO_GENERATION_MODEL;
    else process.env.NVIDIA_VIDEO_GENERATION_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.NVIDIA_VIDEO_GENERATION_BASE_URL;
    else process.env.NVIDIA_VIDEO_GENERATION_BASE_URL = previousBaseUrl;
    globalThis.fetch = previousFetch;
  }
});
