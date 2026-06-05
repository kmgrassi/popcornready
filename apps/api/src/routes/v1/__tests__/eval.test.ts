import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

import {
  EvaluatorRegistry,
  type Evaluator,
  type EvaluatorContext,
  type JudgmentDraft,
} from "@popcorn/eval";

import { createServer } from "@/server";
import { createFileEvalStore, setEvalStoreForTests, type EvalStore } from "@/lib/eval/store";
import { setEvalRegistryForTests } from "@/lib/eval/service";

// End-to-end HTTP coverage for the eval routes (auth + envelope + adapter +
// service + store). Auth in any mode calls ensureWorkspace, which talks to
// Supabase, so — matching apps/api/src/lib/api/v1/__tests__/store.test.ts — these
// run only when Supabase env is configured and are skipped otherwise. The full
// offline behavioral coverage lives in lib/eval/__tests__/service.test.ts, which
// exercises the same service functions the routes delegate to.
const SUPABASE_CONFIGURED = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const httpTest: typeof test = SUPABASE_CONFIGURED ? test : (test.skip as typeof test);

let server: Server;
let baseUrl: string;
let store: EvalStore;
let tmpDir: string;

function stubEvaluator(grade: number): Evaluator {
  return {
    id: "story_arc.v1",
    stageType: "creative_plan",
    modality: "plan",
    rubricVersion: "v1",
    judgeModel: "test-judge",
    schema: {},
    evidenceNeeded: ["artifact_json"],
    style: "reference_free",
    mode: "blocking_gate",
    thresholds: { storyArc: 7 },
    async run(_ctx: EvaluatorContext): Promise<JudgmentDraft> {
      return { grades: { storyArc: grade }, rationale: "stub" };
    },
  };
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "popcornready-eval-route-"));
  store = createFileEvalStore(tmpDir);
  setEvalStoreForTests(store);
  const registry = new EvaluatorRegistry();
  registry.register(stubEvaluator(9));
  setEvalRegistryForTests(registry);

  server = createServer().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  setEvalStoreForTests(null);
  setEvalRegistryForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedSuiteWithCase(): Promise<{ suiteId: string; artifactId: string }> {
  const suite = await store.createSuite({ name: "Route suite" });
  await store.saveCase({
    suiteId: suite.id,
    label: "Launch arc",
    stimulus: {
      kind: "brief",
      goal: "g",
      targetLengthSec: 60,
      style: "doc",
      aspectRatio: "16:9",
    },
    stagesToRun: ["creative_plan"],
    artifacts: [
      {
        stageType: "creative_plan",
        artifactId: "art_route_1",
        artifact: { beats: ["hook", "turn", "payoff"] },
      },
    ],
  });
  return { suiteId: suite.id, artifactId: "art_route_1" };
}

httpTest("GET /api/v1/eval/suites returns the suite list", async () => {
  const { suiteId } = await seedSuiteWithCase();
  const res = await fetch(`${baseUrl}/api/v1/eval/suites`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { suites: Array<{ id: string }> };
  assert.ok(body.suites.some((s) => s.id === suiteId));
});

httpTest("GET /api/v1/eval/suites/:suiteId returns suite + cases", async () => {
  const { suiteId } = await seedSuiteWithCase();
  const res = await fetch(`${baseUrl}/api/v1/eval/suites/${suiteId}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { suite: { id: string }; cases: unknown[] };
  assert.equal(body.suite.id, suiteId);
  assert.equal(body.cases.length, 1);
});

httpTest("GET /api/v1/eval/suites/:suiteId is 404 for an unknown suite", async () => {
  const res = await fetch(`${baseUrl}/api/v1/eval/suites/evalsuite_missing`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "not_found");
});

httpTest("POST /api/v1/eval/runs starts a run and GET returns its detail", async () => {
  const { suiteId } = await seedSuiteWithCase();
  const started = await fetch(`${baseUrl}/api/v1/eval/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ suiteId }),
  });
  assert.equal(started.status, 202);
  const startedBody = (await started.json()) as { run: { id: string } };
  const runId = startedBody.run.id;

  const detail = await fetch(`${baseUrl}/api/v1/eval/runs/${runId}`);
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as {
    run: { id: string };
    judgments: unknown[];
  };
  assert.equal(detailBody.run.id, runId);
  assert.equal(detailBody.judgments.length, 1);
});

httpTest("GET /api/v1/eval/runs/:runId is 404 for an unknown run", async () => {
  const res = await fetch(`${baseUrl}/api/v1/eval/runs/evalrun_missing`);
  assert.equal(res.status, 404);
});

httpTest("POST /api/v1/eval/judgments judges one artifact on demand", async () => {
  const { artifactId } = await seedSuiteWithCase();
  const res = await fetch(`${baseUrl}/api/v1/eval/judgments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evaluatorId: "story_arc.v1", artifactId }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { judgment: { trigger: string; artifactId: string } };
  assert.equal(body.judgment.trigger, "manual");
  assert.equal(body.judgment.artifactId, artifactId);
});

httpTest("POST /api/v1/eval/judgments is 400 for a missing evaluatorId", async () => {
  const res = await fetch(`${baseUrl}/api/v1/eval/judgments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifactId: "art_route_1" }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "validation_failed");
});
