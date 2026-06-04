import { promises as fs } from "fs";
import path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Judgment } from "@popcorn/eval";
import { getServiceSupabase } from "../v1/supabase-client";

// Append-only persistence for Judgment records (Stage Eval Framework §3).
//
// Judgments are immutable: re-judging appends a new row, nothing is overwritten.
// Inline runs set `generationRunId`; offline suite runs set `evalRunId`/`caseId`.
// The production store writes the `judgments` table in Supabase Postgres
// (supabase/migrations/20260604010000_stage_artifacts_and_judgments.sql). A
// file-based store is retained for offline unit tests, matching the dual-store
// pattern in `generation-runs/store.ts`.

export interface JudgmentStore {
  saveJudgment(judgment: Judgment): Promise<Judgment>;
  listJudgmentsForRun(generationRunId: string): Promise<Judgment[]>;
  listJudgmentsForStage(stageId: string): Promise<Judgment[]>;
}

const JUDGMENTS_COLLECTION = "judgments";

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// --- Supabase --------------------------------------------------------------

const PGRST_NO_ROWS = "PGRST116";

function fail(op: string, error: { message?: string } | null): never {
  throw new Error(
    `judgment store: ${op} failed: ${error?.message ?? "unknown error"}`
  );
}

interface JudgmentRow {
  id: string;
  evaluator_id: string;
  rubric_version: string;
  judge_model: string;
  generation_run_id: string | null;
  eval_run_id: string | null;
  case_id: string | null;
  stage_id: string;
  item_id: string | null;
  artifact_id: string | null;
  asset_id: string | null;
  grades: Judgment["grades"];
  verdict: Judgment["verdict"];
  rationale: string;
  recommended_action: Judgment["recommendedAction"] | null;
  evidence_ref: string | null;
  trigger: Judgment["trigger"];
  cost_usd: number;
  latency_ms: number;
  created_at: string;
}

function rowToJudgment(r: JudgmentRow): Judgment {
  const judgment: Judgment = {
    id: r.id,
    evaluatorId: r.evaluator_id,
    rubricVersion: r.rubric_version,
    judgeModel: r.judge_model,
    stageId: r.stage_id,
    grades: r.grades,
    verdict: r.verdict,
    rationale: r.rationale,
    trigger: r.trigger,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  };
  if (r.generation_run_id != null) judgment.generationRunId = r.generation_run_id;
  if (r.eval_run_id != null) judgment.evalRunId = r.eval_run_id;
  if (r.case_id != null) judgment.caseId = r.case_id;
  if (r.item_id != null) judgment.itemId = r.item_id;
  if (r.artifact_id != null) judgment.artifactId = r.artifact_id;
  if (r.asset_id != null) judgment.assetId = r.asset_id;
  if (r.recommended_action != null) judgment.recommendedAction = r.recommended_action;
  if (r.evidence_ref != null) judgment.evidenceRef = r.evidence_ref;
  return judgment;
}

function judgmentToRow(j: Judgment): JudgmentRow {
  return {
    id: j.id,
    evaluator_id: j.evaluatorId,
    rubric_version: j.rubricVersion,
    judge_model: j.judgeModel,
    generation_run_id: j.generationRunId ?? null,
    eval_run_id: j.evalRunId ?? null,
    case_id: j.caseId ?? null,
    stage_id: j.stageId,
    item_id: j.itemId ?? null,
    artifact_id: j.artifactId ?? null,
    asset_id: j.assetId ?? null,
    grades: j.grades,
    verdict: j.verdict,
    rationale: j.rationale,
    recommended_action: j.recommendedAction ?? null,
    evidence_ref: j.evidenceRef ?? null,
    trigger: j.trigger,
    cost_usd: j.costUsd,
    latency_ms: j.latencyMs,
    created_at: j.createdAt,
  };
}

export function createSupabaseJudgmentStore(
  db: SupabaseClient = getServiceSupabase()
): JudgmentStore {
  return {
    async saveJudgment(judgment) {
      const { error } = await db.from("judgments").insert(judgmentToRow(judgment));
      if (error) fail("save judgment", error);
      return judgment;
    },

    async listJudgmentsForRun(generationRunId) {
      const { data, error } = await db
        .from("judgments")
        .select("*")
        .eq("generation_run_id", generationRunId)
        .order("created_at", { ascending: true });
      if (error && error.code !== PGRST_NO_ROWS) fail("list judgments for run", error);
      return ((data as JudgmentRow[]) ?? []).map(rowToJudgment);
    },

    async listJudgmentsForStage(stageId) {
      const { data, error } = await db
        .from("judgments")
        .select("*")
        .eq("stage_id", stageId)
        .order("created_at", { ascending: true });
      if (error && error.code !== PGRST_NO_ROWS) fail("list judgments for stage", error);
      return ((data as JudgmentRow[]) ?? []).map(rowToJudgment);
    },
  };
}

// --- File-based (offline unit tests) ---------------------------------------

export function createFileJudgmentStore(rootDir: string): JudgmentStore {
  function dir(): string {
    return path.join(rootDir, JUDGMENTS_COLLECTION);
  }

  async function readAll(): Promise<Judgment[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir());
    } catch {
      return [];
    }
    const records: Judgment[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir(), name), "utf8");
        records.push(JSON.parse(raw) as Judgment);
      } catch {
        // Skip unreadable/partial records rather than failing the whole list.
      }
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  return {
    async saveJudgment(judgment) {
      await fs.mkdir(dir(), { recursive: true });
      await fs.writeFile(
        path.join(dir(), `${safeKey(judgment.id)}.json`),
        JSON.stringify(judgment, null, 2),
        "utf8"
      );
      return judgment;
    },

    async listJudgmentsForRun(generationRunId) {
      const all = await readAll();
      return all.filter((j) => j.generationRunId === generationRunId);
    },

    async listJudgmentsForStage(stageId) {
      const all = await readAll();
      return all.filter((j) => j.stageId === stageId);
    },
  };
}
