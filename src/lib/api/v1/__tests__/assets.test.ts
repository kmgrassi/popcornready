import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { AuthContext } from "../auth";
import { inventoryAssets, registerAsset, updateAssetContext } from "../assets";
import { createProject, localDir, V1Project } from "../store";

let tmpDir: string;
let sourceDir: string;
let project: V1Project;

const localAuth: AuthContext = {
  mode: "local",
  actor: { id: "local_dev", type: "local" },
  workspaceId: "ws_local",
  isLocal: true,
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-v1-store-"));
  sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-v1-src-"));
  process.env.POPCORN_READY_LOCAL_DIR = tmpDir;
  const created = await createProject({ workspaceId: "ws_local", name: "Host" });
  project = created.project;
});

afterEach(async () => {
  delete process.env.POPCORN_READY_LOCAL_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

test("registerAsset records a remote_url asset as pending", async () => {
  const asset = await registerAsset(localAuth, project.id, {
    source: { type: "remote_url", url: "https://cdn.example.com/clip.mp4" },
    durationSec: 8,
    context: {
      transcriptText: "A quick hook explains the product.",
      moments: [{ startSec: 0, endSec: 8, label: "hook" }],
    },
  });
  assert.equal(asset.status, "pending");
  assert.equal(asset.kind, "video");
  assert.equal(asset.filename, "clip.mp4");
  assert.equal(asset.remoteUrl, "https://cdn.example.com/clip.mp4");
  assert.equal(asset.storageKey, undefined);
  assert.equal(asset.semanticAnalysis?.schemaVersion, "semanticAnalysis.v1");
  assert.equal(asset.assetKnowledge?.mediaType, "video");
  assert.equal(asset.assetKnowledge?.origin, "imported");
  assert.match(asset.assetKnowledge?.knowledgeSummary ?? "", /quick hook/);
  assert.match(asset.clipUnderstanding?.combinedSummary ?? "", /quick hook/);
  assert.equal(asset.semanticAnalysis?.transcript[0].text, "A quick hook explains the product.");
  assert.deepEqual(asset.semanticAnalysis?.segments[0].semanticTags, [
    "video",
    "remote_url",
    "hook",
  ]);
});

test("registerAsset stores structured user context and projects it into semantic analysis", async () => {
  const asset = await registerAsset(localAuth, project.id, {
    source: { type: "remote_url", url: "https://cdn.example.com/founder.mp4" },
    userContext: {
      title: "Founder keynote",
      description: "Founder announces the launch while customers applaud.",
      people: ["Maya"],
      event: "Customer summit",
      intendedUse: ["primary_footage"],
      mustUse: true,
      tags: ["hook"],
    },
  });

  assert.equal(asset.assetKnowledge?.knowledgeScore, 0.35);
  assert.deepEqual(asset.assetKnowledge?.constraints, [{ type: "must_use" }]);
  assert.match(asset.clipUnderstanding?.combinedSummary ?? "", /Founder announces/);
  assert.deepEqual(asset.clipUnderstanding?.timelineHints.preferredBeats, [
    "hook",
  ]);
  assert.equal(
    asset.semanticAnalysis?.segments[0].visualDescription?.includes("Founder announces"),
    true
  );
});

test("updateAssetContext updates knowledge and transcript projection", async () => {
  const asset = await registerAsset(localAuth, project.id, {
    source: { type: "remote_url", url: "https://cdn.example.com/interview.mp4" },
  });

  const updated = await updateAssetContext(localAuth, project.id, asset.id, {
    userContext: {
      description: "Customer describes why the product saved time.",
      intendedUse: ["primary_footage"],
    },
    context: {
      transcriptText: "This saved our team hours every week.",
      moments: [{ startSec: 0, endSec: 4, label: "testimonial" }],
    },
  });

  assert.match(updated.assetKnowledge?.knowledgeSummary ?? "", /Customer describes/);
  assert.equal(updated.semanticAnalysis?.transcript[0].text, "This saved our team hours every week.");
  assert.deepEqual(updated.semanticAnalysis?.segments[0].semanticTags, [
    "video",
    "remote_url",
    "primary_footage",
    "testimonial",
  ]);
});

test("inventoryAssets reports cheap knowns, gaps, and learning actions", async () => {
  const video = await registerAsset(localAuth, project.id, {
    source: { type: "remote_url", url: "https://cdn.example.com/raw.mp4" },
  });
  const audio = await registerAsset(localAuth, project.id, {
    source: { type: "remote_url", url: "https://cdn.example.com/music.mp3" },
    userContext: {
      description: "Upbeat backing track.",
      intendedUse: ["music"],
    },
  });

  const report = await inventoryAssets(localAuth, project.id, {
    includeExistingContext: true,
  });

  assert.equal(report.projectId, project.id);
  assert.equal(report.assets.length, 2);
  assert.equal(report.coverageEstimate.video, "none");
  assert.equal(report.coverageEstimate.audio, "complete");
  assert.ok(
    report.recommendedLearningActions.some(
      (action) => action.assetId === video.id && action.action === "sample_video"
    )
  );
  assert.ok(
    report.assets
      .find((summary) => summary.assetId === audio.id)
      ?.known.some((known) => known.includes("Upbeat backing track"))
  );
});

test("registerAsset copies a local_path asset into managed storage as ready", async () => {
  const src = path.join(sourceDir, "narration.mp3");
  await fs.writeFile(src, "fake-audio-bytes");

  const asset = await registerAsset(localAuth, project.id, {
    source: { type: "local_path", path: src },
  });
  assert.equal(asset.status, "ready");
  assert.equal(asset.kind, "audio");
  assert.ok(asset.storageKey);

  const copied = path.join(localDir(), asset.storageKey!);
  const bytes = await fs.readFile(copied, "utf8");
  assert.equal(bytes, "fake-audio-bytes");
});

test("registerAsset rejects local_path outside local mode", async () => {
  const src = path.join(sourceDir, "clip.mp4");
  await fs.writeFile(src, "x");
  await assert.rejects(
    () =>
      registerAsset(
        { ...localAuth, isLocal: false, mode: "hosted" },
        project.id,
        { source: { type: "local_path", path: src } }
      ),
    /only allowed when AUTH_MODE=local/
  );
});

test("registerAsset rejects a missing local file", async () => {
  await assert.rejects(
    () =>
      registerAsset(localAuth, project.id, {
        source: { type: "local_path", path: path.join(sourceDir, "nope.mp4") },
      }),
    /Local file not found/
  );
});

test("registerAsset rejects unsupported source types", async () => {
  await assert.rejects(
    () =>
      registerAsset(localAuth, project.id, {
        source: { type: "generated", generatedAssetId: "gen_1" },
      }),
    /not supported yet/
  );
});

test("registerAsset requires kind when it cannot be inferred", async () => {
  await assert.rejects(
    () =>
      registerAsset(localAuth, project.id, {
        source: { type: "remote_url", url: "https://cdn.example.com/clip" },
      }),
    /Could not determine asset kind/
  );
});

test("registerAsset fails for an unknown project", async () => {
  await assert.rejects(
    () =>
      registerAsset(localAuth, "proj_missing", {
        source: { type: "remote_url", url: "https://cdn.example.com/clip.mp4" },
      }),
    /Project not found/
  );
});
