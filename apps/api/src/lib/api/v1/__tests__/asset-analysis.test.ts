import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  analyzeAssetBatch,
  getAssetAnalysisJob,
  videoSampleTimes,
} from "../asset-analysis";
import { AuthContext, LOCAL_WORKSPACE_ID } from "../auth";
import { registerAsset } from "../assets";
import { parseAnalyzeBatch } from "../schemas";
import { createProject, getAsset, localDir, V1Project } from "../store";

let tmpDir: string;
let sourceDir: string;
let project: V1Project;
let originalFfmpegPath: string | undefined;
let originalOpenAiKey: string | undefined;

const auth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: LOCAL_WORKSPACE_ID,
  isLocal: true,
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-analysis-"));
  sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-analysis-src-"));
  process.env.POPCORN_READY_LOCAL_DIR = tmpDir;
  originalFfmpegPath = process.env.FFMPEG_PATH;
  originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const created = await createProject({
    workspaceId: LOCAL_WORKSPACE_ID,
    name: "Analysis",
  });
  project = created.project;
});

afterEach(async () => {
  delete process.env.POPCORN_READY_LOCAL_DIR;
  if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = originalFfmpegPath;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

async function fakeFfmpeg(): Promise<string> {
  const script = path.join(sourceDir, "fake-ffmpeg.sh");
  await fs.writeFile(
    script,
    "#!/bin/sh\nfor arg do out=\"$arg\"; done\nprintf 'sample-frame' > \"$out\"\n",
    "utf8"
  );
  await fs.chmod(script, 0o755);
  return script;
}

test("videoSampleTimes uses five default samples and ten for long videos", () => {
  assert.deepEqual(videoSampleTimes(50, 5, 10), [
    8.3,
    16.6,
    24.9,
    33.2,
    41.5,
  ]);
  assert.equal(videoSampleTimes(180, 5, 10).length, 10);
  assert.deepEqual(videoSampleTimes(undefined, 5, 10), [0]);
});

test("parseAnalyzeBatch applies PR2 defaults and validates sample counts", () => {
  const parsed = parseAnalyzeBatch({ assetIds: ["asset_1", "asset_1"] });
  assert.deepEqual(parsed.assetIds, ["asset_1"]);
  assert.equal(parsed.analysisOptions.sampleFrames, true);
  assert.equal(parsed.analysisOptions.transcribeAudio, false);
  assert.equal(parsed.analysisOptions.defaultVideoSamples, 5);
  assert.equal(parsed.analysisOptions.maxVideoSamples, 10);

  assert.throws(
    () =>
      parseAnalyzeBatch({
        assetIds: ["asset_1"],
        analysisOptions: { defaultVideoSamples: 11 },
      }),
    (err: unknown) =>
      typeof (err as { details?: { fields?: { message: string }[] } }).details
        ?.fields?.[0]?.message === "string" &&
      (err as { details: { fields: { message: string }[] } }).details.fields[0].message.includes(
        "between 1 and 10"
      )
  );
});

test("analyzeAssetBatch samples frames and persists structured low-confidence observations", async () => {
  process.env.FFMPEG_PATH = await fakeFfmpeg();
  const src = path.join(sourceDir, "clip.mp4");
  await fs.writeFile(src, "fake-video");
  const asset = await registerAsset(auth, project.id, {
    source: { type: "local_path", path: src },
    durationSec: 60,
  });

  const response = await analyzeAssetBatch({
    auth,
    projectId: project.id,
    input: parseAnalyzeBatch({ assetIds: [asset.id] }),
  });
  const job = response.body.job as { id: string; status: string; type: string };
  assert.equal(response.status, 202);
  assert.equal(job.type, "asset_analysis");
  assert.equal(job.status, "succeeded");

  const updated = await getAsset(LOCAL_WORKSPACE_ID, project.id, asset.id);
  assert.equal(updated.analysis?.status, "succeeded");
  assert.equal(updated.analysis?.sampledFrames.length, 5);
  assert.equal(updated.analysis?.observations?.confidence, "low");
  assert.match(updated.context?.summary || "", /OPENAI_API_KEY is not set/);
  assert.equal(updated.semanticAnalysis?.segments[0].visualDescription, updated.context?.summary);

  const firstFrame = path.join(localDir(), updated.analysis!.sampledFrames[0]);
  assert.equal(await fs.readFile(firstFrame, "utf8"), "sample-frame");

  const polled = await getAssetAnalysisJob({
    auth,
    projectId: project.id,
    jobId: job.id,
  });
  assert.equal((polled.body.job as { status: string }).status, "succeeded");
});

test("analyzeAssetBatch records a failed analysis when ffmpeg is unavailable", async () => {
  process.env.FFMPEG_PATH = path.join(sourceDir, "missing-ffmpeg");
  const src = path.join(sourceDir, "clip.mp4");
  await fs.writeFile(src, "fake-video");
  const asset = await registerAsset(auth, project.id, {
    source: { type: "local_path", path: src },
    durationSec: 12,
  });

  const response = await analyzeAssetBatch({
    auth,
    projectId: project.id,
    input: parseAnalyzeBatch({ assetIds: [asset.id] }),
  });
  const job = response.body.job as { status: string; error?: { code: string } };
  assert.equal(job.status, "failed");
  assert.equal(job.error?.code, "asset_analysis_failed");

  const updated = await getAsset(LOCAL_WORKSPACE_ID, project.id, asset.id);
  assert.equal(updated.analysis?.status, "failed");
  assert.equal(updated.analysis?.error?.code, "asset_invalid");
  assert.match(updated.analysis?.error?.message || "", /ffmpeg is not available/);
});
