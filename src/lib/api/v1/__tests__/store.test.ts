import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { VideoBrief } from "../schemas";
import {
  addAsset,
  createBriefVersion,
  createProject,
  ensureWorkspace,
  findIdempotencyRecord,
  getProject,
  listAssets,
  listProjects,
  saveIdempotencyRecord,
  setBrief,
  V1Asset,
} from "../store";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aividi-v1-"));
  process.env.AIVIDI_LOCAL_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.AIVIDI_LOCAL_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function brief(goal: string): VideoBrief {
  return { goal, targetLengthSec: 15, aspectRatio: "9:16" };
}

function asset(id: string, projectId: string, workspaceId: string): V1Asset {
  const now = new Date().toISOString();
  return {
    id,
    schemaVersion: "asset.v1",
    workspaceId,
    projectId,
    kind: "video",
    filename: `${id}.mp4`,
    status: "pending",
    source: { type: "remote_url", url: "https://example.com/x.mp4" },
    remoteUrl: "https://example.com/x.mp4",
    createdAt: now,
    updatedAt: now,
  };
}

test("createProject without brief persists and is readable", async () => {
  await ensureWorkspace("ws_a", "A");
  const { project, briefVersion } = await createProject({
    workspaceId: "ws_a",
    name: "Teaser",
  });
  assert.equal(briefVersion, null);
  assert.equal(project.brief, null);
  assert.equal(project.schemaVersion, "project.v1");
  assert.equal(project.status, "active");

  const read = await getProject("ws_a", project.id);
  assert.equal(read.name, "Teaser");
});

test("createProject with brief creates an initial brief version", async () => {
  const { project, briefVersion } = await createProject({
    workspaceId: "ws_a",
    name: "Teaser",
    brief: brief("Make a teaser"),
  });
  assert.ok(briefVersion);
  assert.equal(project.currentBriefVersionId, briefVersion!.id);
  assert.equal(project.brief?.goal, "Make a teaser");
});

test("getProject is scoped to its workspace", async () => {
  const { project } = await createProject({ workspaceId: "ws_a", name: "A" });
  await assert.rejects(
    () => getProject("ws_b", project.id),
    /Project not found/
  );
});

test("setBrief and createBriefVersion update the project", async () => {
  const { project } = await createProject({ workspaceId: "ws_a", name: "A" });
  await setBrief("ws_a", project.id, brief("v0"));
  const afterSet = await getProject("ws_a", project.id);
  assert.equal(afterSet.brief?.goal, "v0");

  const { project: afterVersion, briefVersion } = await createBriefVersion(
    "ws_a",
    project.id,
    brief("v1")
  );
  assert.equal(afterVersion.brief?.goal, "v1");
  assert.equal(afterVersion.currentBriefVersionId, briefVersion.id);
});

test("listProjects only returns the requested workspace, newest first", async () => {
  const first = await createProject({ workspaceId: "ws_a", name: "first" });
  // Ensure distinct createdAt ordering.
  await new Promise((r) => setTimeout(r, 5));
  const second = await createProject({ workspaceId: "ws_a", name: "second" });
  await createProject({ workspaceId: "ws_other", name: "other" });

  const { items } = await listProjects("ws_a", 50, null);
  assert.deepEqual(
    items.map((p) => p.id),
    [second.project.id, first.project.id]
  );
});

test("listProjects paginates with a cursor", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { project } = await createProject({ workspaceId: "ws_a", name: `p${i}` });
    ids.push(project.id);
    await new Promise((r) => setTimeout(r, 2));
  }
  const page1 = await listProjects("ws_a", 2, null);
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);

  const page2 = await listProjects("ws_a", 2, page1.nextCursor);
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextCursor, null);

  const seen = [...page1.items, ...page2.items].map((p) => p.id).sort();
  assert.deepEqual(seen, [...ids].sort());
});

test("assets are listed only within their project", async () => {
  await addAsset(asset("asset_1", "proj_a", "ws_a"));
  await addAsset(asset("asset_2", "proj_a", "ws_a"));
  await addAsset(asset("asset_3", "proj_b", "ws_a"));
  await createProject({ workspaceId: "ws_a", name: "ignored" });

  // listAssets requires the project to exist; create it explicitly.
  const { project } = await createProject({ workspaceId: "ws_a", name: "host" });
  await addAsset(asset("asset_4", project.id, "ws_a"));
  const { items } = await listAssets("ws_a", project.id, 50, null);
  assert.deepEqual(
    items.map((a) => a.id),
    ["asset_4"]
  );
});

test("idempotency records persist and are found by scope+key", async () => {
  const found0 = await findIdempotencyRecord("scope", "key1");
  assert.equal(found0, undefined);

  await saveIdempotencyRecord({
    scope: "scope",
    key: "key1",
    bodyHash: "abc",
    status: 201,
    responseBody: { project: { id: "proj_1" } },
    createdAt: new Date().toISOString(),
  });

  const found = await findIdempotencyRecord("scope", "key1");
  assert.ok(found);
  assert.equal(found!.bodyHash, "abc");
  assert.equal(found!.status, 201);

  // Saving the same scope+key again does not duplicate.
  await saveIdempotencyRecord({
    scope: "scope",
    key: "key1",
    bodyHash: "abc",
    status: 201,
    responseBody: {},
    createdAt: new Date().toISOString(),
  });
  const again = await findIdempotencyRecord("scope", "key1");
  assert.equal(again!.responseBody && (again!.responseBody as any).project.id, "proj_1");
});
