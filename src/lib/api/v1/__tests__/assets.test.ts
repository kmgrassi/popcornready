import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { AuthContext } from "../auth";
import { registerAsset } from "../assets";
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
  process.env.AIVIDI_LOCAL_DIR = tmpDir;
  const created = await createProject({ workspaceId: "ws_local", name: "Host" });
  project = created.project;
});

afterEach(async () => {
  delete process.env.AIVIDI_LOCAL_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

test("registerAsset records a remote_url asset as pending", async () => {
  const asset = await registerAsset(localAuth, project.id, {
    source: { type: "remote_url", url: "https://cdn.example.com/clip.mp4" },
  });
  assert.equal(asset.status, "pending");
  assert.equal(asset.kind, "video");
  assert.equal(asset.filename, "clip.mp4");
  assert.equal(asset.remoteUrl, "https://cdn.example.com/clip.mp4");
  assert.equal(asset.storageKey, undefined);
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
