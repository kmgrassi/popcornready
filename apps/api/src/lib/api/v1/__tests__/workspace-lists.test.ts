import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkspaceDashboardSummary,
  listWorkspaceGenerationRuns,
  listWorkspaceOutputs,
  type GetWorkspaceDashboardSummaryDeps,
  type ListWorkspaceGenerationRunsDeps,
  type ListWorkspaceOutputsDeps,
} from "../store";
import type { GenerationRunsStore } from "../../../v1/generation-runs/store";
import type { GenerationRun } from "@popcorn/shared/v1/types";
import type { Artifact } from "../../../agent-api/types";

// Unit coverage for the workspace-scoped cross-project aggregations that back
// the dashboard Projects/Runs + Outputs views. The project enumeration and the
// per-project run/artifact stores are injected, so these exercise the
// aggregation/filter/pagination logic without Supabase or the filesystem. The
// route + RLS layer is the same auth path the assets handler uses (covered by
// the Supabase-gated route suites).

function makeRun(
  projectId: string,
  overrides: Partial<GenerationRun> & { runId: string }
): GenerationRun {
  return {
    projectId,
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeArtifact(
  projectId: string,
  overrides: Partial<Artifact> & { id: string }
): Artifact {
  return {
    projectId,
    kind: "video/mp4",
    status: "ready",
    url: `https://cdn.example/${overrides.id}.mp4`,
    timelineId: "tl_1",
    durationSec: 12,
    renderPlan: { format: "mp4", quality: "high" } as Artifact["renderPlan"],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function runStoreFrom(runs: GenerationRun[]): GenerationRunsStore {
  return {
    listRunsForProject: async (projectId: string) =>
      runs.filter((r) => r.projectId === projectId),
  } as unknown as GenerationRunsStore;
}

function artifactStoreFrom(
  artifacts: Artifact[]
): ListWorkspaceOutputsDeps["artifactStore"] {
  return {
    listArtifactsForProject: async (projectId) =>
      artifacts.filter((a) => a.projectId === projectId),
  };
}

test("listWorkspaceGenerationRuns aggregates runs across projects with project names", async () => {
  const runs = [
    makeRun("p1", { runId: "r1", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeRun("p2", {
      runId: "r2",
      status: "running",
      createdAt: "2026-01-02T00:00:00.000Z",
    }),
  ];
  const deps: ListWorkspaceGenerationRunsDeps = {
    listProjects: async () => [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ],
    runStore: runStoreFrom(runs),
  };

  const { items, nextCursor } = await listWorkspaceGenerationRuns(
    "ws1",
    {},
    50,
    null,
    deps
  );

  assert.equal(nextCursor, null);
  assert.equal(items.length, 2);
  // Newest-first.
  assert.equal(items[0].runId, "r2");
  assert.equal(items[0].projectName, "Beta");
  assert.equal(items[1].runId, "r1");
  assert.equal(items[1].projectName, "Alpha");
  // No internal pagination key leaks onto the wire shape.
  assert.ok(!("id" in items[0]));
});

test("listWorkspaceGenerationRuns filters by status and projectId", async () => {
  const runs = [
    makeRun("p1", { runId: "r1", status: "succeeded" }),
    makeRun("p1", { runId: "r2", status: "failed" }),
    makeRun("p2", { runId: "r3", status: "succeeded" }),
  ];
  const deps: ListWorkspaceGenerationRunsDeps = {
    listProjects: async () => [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ],
    runStore: runStoreFrom(runs),
  };

  const byStatus = await listWorkspaceGenerationRuns(
    "ws1",
    { status: "succeeded" },
    50,
    null,
    deps
  );
  assert.deepEqual(
    byStatus.items.map((r) => r.runId).sort(),
    ["r1", "r3"]
  );

  const byProject = await listWorkspaceGenerationRuns(
    "ws1",
    { projectId: "p1" },
    50,
    null,
    deps
  );
  assert.deepEqual(
    byProject.items.map((r) => r.runId).sort(),
    ["r1", "r2"]
  );
});

test("listWorkspaceGenerationRuns paginates with a stable runId cursor", async () => {
  const runs = [
    makeRun("p1", { runId: "r1", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeRun("p1", { runId: "r2", createdAt: "2026-01-02T00:00:00.000Z" }),
    makeRun("p1", { runId: "r3", createdAt: "2026-01-03T00:00:00.000Z" }),
  ];
  const deps: ListWorkspaceGenerationRunsDeps = {
    listProjects: async () => [{ id: "p1", name: "Alpha" }],
    runStore: runStoreFrom(runs),
  };

  const page1 = await listWorkspaceGenerationRuns("ws1", {}, 2, null, deps);
  assert.deepEqual(page1.items.map((r) => r.runId), ["r3", "r2"]);
  assert.equal(page1.nextCursor, "r2");

  const page2 = await listWorkspaceGenerationRuns(
    "ws1",
    {},
    2,
    page1.nextCursor,
    deps
  );
  assert.deepEqual(page2.items.map((r) => r.runId), ["r1"]);
  assert.equal(page2.nextCursor, null);
});

test("listWorkspaceOutputs aggregates export artifacts and maps to the wire shape", async () => {
  const artifacts = [
    makeArtifact("p1", { id: "a1", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeArtifact("p2", { id: "a2", createdAt: "2026-01-02T00:00:00.000Z" }),
  ];
  const deps: ListWorkspaceOutputsDeps = {
    listProjects: async () => [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ],
    artifactStore: artifactStoreFrom(artifacts),
  };

  const { items, nextCursor } = await listWorkspaceOutputs(
    "ws1",
    {},
    50,
    null,
    deps
  );

  assert.equal(nextCursor, null);
  assert.equal(items.length, 2);
  // Newest-first.
  assert.equal(items[0].artifactId, "a2");
  assert.equal(items[0].projectName, "Beta");
  assert.equal(items[0].format, "mp4");
  assert.equal(items[0].url, "https://cdn.example/a2.mp4");
  assert.equal(items[0].timelineId, "tl_1");
  assert.ok(!("id" in items[0]));
});

test("listWorkspaceOutputs scopes by projectId and tolerates a null url", async () => {
  const artifacts = [
    makeArtifact("p1", { id: "a1", url: null }),
    makeArtifact("p2", { id: "a2" }),
  ];
  const deps: ListWorkspaceOutputsDeps = {
    listProjects: async () => [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ],
    artifactStore: artifactStoreFrom(artifacts),
  };

  const { items } = await listWorkspaceOutputs(
    "ws1",
    { projectId: "p1" },
    50,
    null,
    deps
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].artifactId, "a1");
  assert.equal(items[0].url, undefined);
});

test("getWorkspaceDashboardSummary returns launchpad counts and capped newest activity", async () => {
  const runs = [
    makeRun("p1", {
      runId: "r1",
      status: "running",
      currentStageType: "asset_generation",
      progressPercent: 40,
      updatedAt: "2026-01-03T00:00:00.000Z",
    }),
    makeRun("p2", {
      runId: "r2",
      status: "queued",
      updatedAt: "2026-01-04T00:00:00.000Z",
    }),
    makeRun("p2", {
      runId: "r3",
      status: "succeeded",
      updatedAt: "2026-01-05T00:00:00.000Z",
    }),
  ];
  const artifacts = [
    makeArtifact("p1", { id: "a1", createdAt: "2026-01-01T00:00:00.000Z" }),
    makeArtifact("p2", { id: "a2", createdAt: "2026-01-02T00:00:00.000Z" }),
  ];
  const deps: GetWorkspaceDashboardSummaryDeps = {
    listProjects: async () => [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ],
    runStore: runStoreFrom(runs),
    artifactStore: artifactStoreFrom(artifacts),
  };

  const summary = await getWorkspaceDashboardSummary("ws1", deps);

  assert.equal(summary.schemaVersion, "dashboard.v1");
  assert.deepEqual(summary.counts, {
    projects: 2,
    activeRuns: 2,
    outputs: 2,
  });
  assert.deepEqual(
    summary.activeRuns.map((run) => run.runId),
    ["r2", "r1"]
  );
  assert.equal(summary.activeRuns[1].projectName, "Alpha");
  assert.equal(summary.activeRuns[1].currentStageType, "asset_generation");
  assert.equal(summary.activeRuns[1].progressPercent, 40);
  assert.deepEqual(
    summary.recentOutputs.map((output) => output.artifactId),
    ["a2", "a1"]
  );
});

test("getWorkspaceDashboardSummary includes reviewGate for gated runs", async () => {
  const runs = [
    makeRun("p1", {
      runId: "r1",
      status: "running",
      reviewGate: {
        stageType: "quality_review",
        stageId: "stage_1",
        state: "awaiting_review",
        enteredAt: "2026-01-03T00:00:00.000Z",
      },
    }),
  ];
  const deps: GetWorkspaceDashboardSummaryDeps = {
    listProjects: async () => [{ id: "p1", name: "Alpha" }],
    runStore: runStoreFrom(runs),
    artifactStore: artifactStoreFrom([]),
  };

  const summary = await getWorkspaceDashboardSummary("ws1", deps);

  assert.equal(summary.activeRuns.length, 1);
  assert.equal(summary.activeRuns[0].reviewGate?.stageType, "quality_review");
});
