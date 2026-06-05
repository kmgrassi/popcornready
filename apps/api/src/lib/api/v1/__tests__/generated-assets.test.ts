import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Point the agent store + generated media at a throwaway temp dir before any
// store call. store.localDir()/jobs read this lazily, so setting it here is enough.
process.env.POPCORN_READY_LOCAL_DIR = path.join(
  os.tmpdir(),
  `popcornready-pr2-${process.pid}-${Date.now()}`
);
delete process.env.AUTH_MODE;

import { AuthContext } from "../auth";
import { ApiError } from "../errors";

// DB-generated workspace uuid stand-in for these Supabase-gated tests (skipped
// unless SUPABASE_* env is set).
const LOCAL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
import {
  createGeneratedAsset,
  getGeneratedAssetJob,
} from "../generated-assets";
import { V1Job } from "../jobs";
import { createProject, getAsset, listAssets } from "../store";

// These exercise the v1 store, which now persists to Supabase Postgres (needs a
// live PostgREST gateway). Skipped unless Supabase env is configured; the store's
// asset round-trips are proven by the dockerized pg harness in this PR.
const SUPABASE_CONFIGURED = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const dbTest: typeof test = SUPABASE_CONFIGURED ? test : (test.skip as typeof test);

const auth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: LOCAL_WORKSPACE_ID,
  isLocal: true,
};

async function newProjectId(name: string): Promise<string> {
  const { project } = await createProject({
    workspaceId: LOCAL_WORKSPACE_ID,
    name,
  });
  return project.id;
}

function jobOf(result: { body: Record<string, unknown> }): V1Job {
  return result.body.job as V1Job;
}

function assetIds(job: V1Job): string[] {
  return (job.result as { assetIds: string[] }).assetIds;
}

async function expectApiError(
  promise: Promise<unknown>,
  code: ApiError["code"]
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

dbTest("creates image, video, and audio generated assets and lists them", async () => {
  const projectId = await newProjectId("agent video");

  const image = await createGeneratedAsset({
    auth,
    projectId,
    body: { kind: "image", provider: "mock", prompt: "petri dish hook" },
  });
  assert.equal(image.status, 202);
  assert.equal(jobOf(image).status, "succeeded");
  assert.equal(jobOf(image).type, "asset_generation");

  const video = await createGeneratedAsset({
    auth,
    projectId,
    body: {
      kind: "video",
      provider: "mock",
      prompt: "workflow reveal",
      durationSec: 6,
    },
  });
  assert.equal(jobOf(video).status, "succeeded");

  const audio = await createGeneratedAsset({
    auth,
    projectId,
    body: {
      kind: "audio",
      provider: "mock",
      prompt: "calm narration",
      durationSec: 5,
    },
  });
  assert.equal(jobOf(audio).status, "succeeded");

  // Poll the job through the GET endpoint.
  const polled = await getGeneratedAssetJob({
    auth,
    projectId,
    jobId: jobOf(audio).id,
  });
  assert.equal(jobOf(polled).status, "succeeded");

  // List through the standard PR1 asset store (what GET /assets surfaces).
  const { items } = await listAssets(LOCAL_WORKSPACE_ID, projectId, 50, null);
  assert.equal(items.length, 3);
  assert.deepEqual(
    [...items.map((a) => a.kind)].sort(),
    ["audio", "image", "video"]
  );
  assert.ok(items.every((a) => a.source.type === "generated"));
});

dbTest("persists actual audio duration in provenance", async () => {
  const projectId = await newProjectId("audio provenance");

  const res = await createGeneratedAsset({
    auth,
    projectId,
    body: {
      kind: "audio",
      provider: "mock",
      prompt: "five second line",
      durationSec: 5,
    },
  });

  const id = assetIds(jobOf(res))[0];
  const asset = await getAsset(LOCAL_WORKSPACE_ID, projectId, id);
  assert.equal(asset.kind, "audio");
  assert.equal(asset.provenance?.provider, "mock");
  assert.equal(asset.provenance?.requestedDurationSec, 5);
  // Mock returns a real 8kHz WAV of the requested length.
  assert.equal(asset.provenance?.actualDurationSec, 5);
  assert.equal(asset.durationSec, 5);
});

dbTest("persists provider settings used to produce the asset", async () => {
  const projectId = await newProjectId("provider settings");

  const image = await createGeneratedAsset({
    auth,
    projectId,
    body: {
      kind: "image",
      provider: "mock",
      prompt: "settings",
      size: "1024x1024",
      quality: "high",
    },
  });
  const imageAsset = await getAsset(
    LOCAL_WORKSPACE_ID,
    projectId,
    assetIds(jobOf(image))[0]
  );
  assert.equal(imageAsset.provenance?.providerSettings?.size, "1024x1024");
  assert.equal(imageAsset.provenance?.providerSettings?.quality, "high");

  const audio = await createGeneratedAsset({
    auth,
    projectId,
    body: {
      kind: "audio",
      provider: "mock",
      prompt: "voice over",
      durationSec: 4,
      voiceId: "voice_123",
      outputFormat: "mp3_44100_192",
      audioMode: "speech",
    },
  });
  const audioAsset = await getAsset(
    LOCAL_WORKSPACE_ID,
    projectId,
    assetIds(jobOf(audio))[0]
  );
  assert.equal(audioAsset.provenance?.providerSettings?.voiceId, "voice_123");
  assert.equal(
    audioAsset.provenance?.providerSettings?.outputFormat,
    "mp3_44100_192"
  );
  assert.equal(audioAsset.provenance?.providerSettings?.audioMode, "speech");
});

dbTest("routes NVIDIA Cosmos video through the generated-assets adapter", async (t) => {
  const projectId = await newProjectId("nvidia generated asset");
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.NVIDIA_API_KEY;
  const originalModel = process.env.NVIDIA_VIDEO_GENERATION_MODEL;
  const originalBaseUrl = process.env.NVIDIA_VIDEO_GENERATION_BASE_URL;
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  process.env.NVIDIA_API_KEY = "nvidia-test-key";
  process.env.NVIDIA_VIDEO_GENERATION_MODEL = "nvidia/cosmos3-nano";
  process.env.NVIDIA_VIDEO_GENERATION_BASE_URL = "https://ai.api.nvidia.com/v1/genai";
  globalThis.fetch = (async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body || "{}")),
    });
    return new Response(
      JSON.stringify({ b64_video: Buffer.from("mp4").toString("base64") }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.NVIDIA_VIDEO_GENERATION_MODEL;
    else process.env.NVIDIA_VIDEO_GENERATION_MODEL = originalModel;
    if (originalBaseUrl === undefined) {
      delete process.env.NVIDIA_VIDEO_GENERATION_BASE_URL;
    } else {
      process.env.NVIDIA_VIDEO_GENERATION_BASE_URL = originalBaseUrl;
    }
  });

  const res = await createGeneratedAsset({
    auth,
    projectId,
    body: {
      kind: "video",
      provider: "nvidia_api_catalog",
      prompt: "cosmos warehouse shot",
      durationSec: 4,
      resolution: "480_16_9",
      frameCount: 24,
      fps: 12,
      steps: 8,
      guidanceScale: 5,
      seed: 42,
      negativePrompt: "blur",
    },
  });

  assert.equal(jobOf(res).status, "succeeded");
  assert.equal(calls[0].url, "https://ai.api.nvidia.com/v1/genai/nvidia/cosmos3-nano");
  assert.deepEqual(calls[0].body, {
    prompt: "cosmos warehouse shot",
    negative_prompt: "blur",
    seed: 42,
    resolution: "480_16_9",
    num_output_frames: 24,
    fps: 12,
    steps: 8,
    guidance_scale: 5,
  });

  const asset = await getAsset(
    LOCAL_WORKSPACE_ID,
    projectId,
    assetIds(jobOf(res))[0]
  );
  assert.equal(asset.kind, "video");
  assert.equal(asset.provenance?.provider, "nvidia_api_catalog");
  assert.equal(asset.provenance?.providerSettings?.seed, 42);
  assert.equal(asset.provenance?.providerSettings?.frameCount, 24);
  assert.equal(asset.provenance?.providerSettings?.fps, 12);
  assert.equal(asset.provenance?.providerSettings?.steps, 8);
  assert.equal(asset.provenance?.providerSettings?.guidanceScale, 5);
  assert.equal(asset.provenance?.providerSettings?.negativePrompt, "blur");
  assert.equal(asset.provenance?.providerSettings?.resolution, "480_16_9");
});

dbTest("records character binding metadata when character fields are provided", async () => {
  const projectId = await newProjectId("character binding");

  const res = await createGeneratedAsset({
    auth,
    projectId,
    body: {
      kind: "image",
      provider: "mock",
      prompt: "fleming portrait",
      characterProfileIds: ["char_fleming"],
      characterReferenceIds: ["ref_hero"],
      consistencyMode: "hero_frame",
    },
  });

  const asset = await getAsset(
    LOCAL_WORKSPACE_ID,
    projectId,
    assetIds(jobOf(res))[0]
  );
  assert.deepEqual(asset.provenance?.characterBinding?.characterProfileIds, [
    "char_fleming",
  ]);
  assert.equal(
    asset.provenance?.characterBinding?.consistencyMode,
    "hero_frame"
  );
});

dbTest("returns typed errors for unsupported and invalid requests", async () => {
  const projectId = await newProjectId("errors");

  // Audio requested from an image/video-only provider.
  await expectApiError(
    createGeneratedAsset({
      auth,
      projectId,
      body: { kind: "audio", provider: "openai", prompt: "voice" },
    }),
    "validation_failed"
  );

  // Image requested from a video-only provider.
  await expectApiError(
    createGeneratedAsset({
      auth,
      projectId,
      body: { kind: "image", provider: "gemini", prompt: "frame" },
    }),
    "validation_failed"
  );

  // Unknown provider.
  await expectApiError(
    createGeneratedAsset({
      auth,
      projectId,
      body: { kind: "image", provider: "made-up", prompt: "x" },
    }),
    "validation_failed"
  );

  // Invalid consistency mode.
  await expectApiError(
    createGeneratedAsset({
      auth,
      projectId,
      body: {
        kind: "image",
        provider: "mock",
        prompt: "x",
        consistencyMode: "telepathy",
      },
    }),
    "validation_failed"
  );

  // Missing prompt.
  await expectApiError(
    createGeneratedAsset({
      auth,
      projectId,
      body: { kind: "image", provider: "mock" },
    }),
    "validation_failed"
  );

  // Unknown project.
  await expectApiError(
    createGeneratedAsset({
      auth,
      projectId: "proj_missing",
      body: { kind: "image", provider: "mock", prompt: "x" },
    }),
    "not_found"
  );
});
