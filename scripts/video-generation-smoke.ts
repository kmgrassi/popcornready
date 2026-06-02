import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const API_BASE_URL = trimTrailingSlash(
  process.env.VIDEO_GENERATION_SMOKE_API_URL || "http://127.0.0.1:3000"
);
const PROJECT_ID = process.env.VIDEO_GENERATION_SMOKE_PROJECT_ID;
const PROJECT_NAME =
  process.env.VIDEO_GENERATION_SMOKE_PROJECT_NAME ||
  "NVIDIA Cosmos smoke test";
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

  const projectId = PROJECT_ID || (await createProject()).id;
  const generation = await jsonRequest<JobEnvelope>(
    `${API_BASE_URL}/api/v1/projects/${encodeURIComponent(
      projectId
    )}/generated-assets`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "video",
        provider: "nvidia_api_catalog",
        prompt: PROMPT,
        resolution: process.env.VIDEO_GENERATION_SMOKE_RESOLUTION || "480_16_9",
        frameCount: Number(process.env.VIDEO_GENERATION_SMOKE_FRAME_COUNT || "24"),
        seed: Number(process.env.VIDEO_GENERATION_SMOKE_SEED || "42"),
      }),
    }
  );

  const jobId = generation.job?.id;
  if (!jobId) {
    fail("missing_job_id", generation);
  }

  const job = await pollJob(projectId, jobId);
  const assetId = job.result?.assetIds?.[0];
  if (!assetId) {
    fail("missing_asset_id", job);
  }

  const assetBody = await jsonRequest<AssetEnvelope>(
    `${API_BASE_URL}/api/v1/projects/${encodeURIComponent(
      projectId
    )}/assets/${encodeURIComponent(assetId)}`
  );
  const storageKey = assetBody.asset?.storageKey;
  if (!storageKey) {
    fail("missing_asset_storage_key", assetBody);
  }

  const sourcePath = resolve(localStoreDir(), storageKey);
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await copyFile(sourcePath, OUTPUT_PATH);

  console.log(
    JSON.stringify({
      event: "video_generation_smoke_passed",
      provider: assetBody.asset?.provenance?.provider,
      model: assetBody.asset?.provenance?.model,
      projectId,
      jobId,
      assetId,
      sourcePath,
      outputPath: OUTPUT_PATH,
    })
  );
}

async function createProject(): Promise<Project> {
  const body = await jsonRequest<ProjectEnvelope>(`${API_BASE_URL}/api/v1/projects`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: PROJECT_NAME,
    }),
  });
  if (!body.project?.id) {
    fail("missing_project_id", body);
  }
  return body.project;
}

async function pollJob(projectId: string, jobId: string): Promise<Job> {
  const timeoutMs = Number(
    process.env.VIDEO_GENERATION_SMOKE_TIMEOUT_MS || "600000"
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await jsonRequest<JobEnvelope>(
      `${API_BASE_URL}/api/v1/projects/${encodeURIComponent(
        projectId
      )}/generated-assets/${encodeURIComponent(jobId)}`
    );
    const job = body.job;
    if (job?.status === "succeeded") return job;
    if (job?.status === "failed" || job?.status === "canceled") {
      fail("job_not_succeeded", job);
    }
    await sleep(Number(process.env.VIDEO_GENERATION_SMOKE_POLL_MS || "2000"));
  }
  fail("job_poll_timeout", { projectId, jobId });
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: unknown;
  };
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "video_generation_smoke_failed",
        status: response.status,
        url,
        error: body.error || body,
      })
    );
    process.exit(1);
  }
  return body;
}

function fail(reason: string, body: unknown): never {
  console.error(
    JSON.stringify({
      event: "video_generation_smoke_failed",
      reason,
      body,
    })
  );
  process.exit(1);
}

function localStoreDir() {
  return process.env.POPCORN_READY_LOCAL_DIR || join(process.cwd(), ".local");
}

type Project = {
  id: string;
};

type ProjectEnvelope = {
  project?: Project;
  error?: unknown;
};

type Job = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  result?: {
    assetIds?: string[];
  };
  error?: unknown;
};

type JobEnvelope = {
  job?: Job;
  error?: unknown;
};

type AssetEnvelope = {
  asset?: {
    id: string;
    storageKey?: string;
    provenance?: {
      provider?: string;
      model?: string;
    };
  };
  error?: unknown;
};

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
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
