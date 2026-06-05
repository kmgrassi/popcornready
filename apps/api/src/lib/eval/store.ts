// Persistence for the stage eval framework entities.
//
// One store, two backends, selected by the same DB_BACKEND flag the rest of the
// stack uses (supabase/storage.ts): Supabase Postgres in production, a file-based
// store for offline unit tests + local dev without a live DB. Routes/handlers
// call the interface below and never see SQL or supabase-js, so the backend can
// change here without touching anything upstream.
//
// Entity shapes mirror packages/eval/src/types.ts exactly. Eval entities are
// GLOBAL admin/tooling records — no workspace/project tenancy — so there are no
// tenancy filters here (cf. apps/api/src/lib/api/v1/store.ts, which is multi-tenant).
//
// `judgments` are append-only/immutable: saveJudgment only ever inserts; there is
// no update or delete. Re-judging an artifact adds a new row (the regression
// trend and audit history fall out for free).

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getServiceSupabase } from "@/lib/v1/supabase-client";
import { useSupabaseStorage } from "@/lib/supabase/storage";
import type {
  EvalFixtureArtifact,
  EvalFixtureCase,
  EvalRun,
  EvalSuite,
  ExpectationResult,
  Judgment,
} from "@popcorn/eval";

// --- Input types -----------------------------------------------------------

// Ids are DB-generated (uuid default gen_random_uuid); create inputs omit `id`
// and the store reads the generated id back onto the returned entity.
export type CreateEvalSuiteInput = Omit<EvalSuite, "id">;

// A case carries its inline/media artifacts (EvalFixtureCase) so the suite runner
// can replay it without re-reaching the live pipeline. `artifacts` defaults to []
// when omitted (a stimulus-only case the live pipeline will fill in).
export type CreateEvalCaseInput = Omit<EvalFixtureCase, "id" | "artifacts"> & {
  artifacts?: EvalFixtureArtifact[];
};

// EvalRun.createdAt is assigned on insert; the id is DB-generated (the runner's
// in-memory id is a placeholder remapped by the service on persist).
export type CreateEvalRunInput = Omit<EvalRun, "id" | "createdAt"> & {
  createdAt?: string;
};

// --- Store interface -------------------------------------------------------

export interface EvalStore {
  // suites + cases
  createSuite(input: CreateEvalSuiteInput): Promise<EvalSuite>;
  getSuite(suiteId: string): Promise<EvalSuite | null>;
  listSuites(): Promise<EvalSuite[]>;

  saveCase(input: CreateEvalCaseInput): Promise<EvalFixtureCase>;
  getCase(caseId: string): Promise<EvalFixtureCase | null>;
  listCasesForSuite(suiteId: string): Promise<EvalFixtureCase[]>;

  // runs
  saveRun(input: CreateEvalRunInput): Promise<EvalRun>;
  getRun(runId: string): Promise<EvalRun | null>;
  listRunsForSuite(suiteId: string): Promise<EvalRun[]>;

  // judgments (append-only) + expectation results
  saveJudgment(judgment: Judgment): Promise<Judgment>;
  getJudgment(judgmentId: string): Promise<Judgment | null>;
  listJudgmentsForRun(runId: string): Promise<Judgment[]>;

  saveExpectationResult(result: ExpectationResult): Promise<ExpectationResult>;
  listExpectationResultsForRun(runId: string): Promise<ExpectationResult[]>;
}

const COLLECTIONS = {
  suites: "eval-suites",
  cases: "eval-cases",
  runs: "eval-runs",
  judgments: "judgments",
  expectationResults: "expectation-results",
} as const;

// ---------------------------------------------------------------------------
// Supabase (Postgres) implementation
// ---------------------------------------------------------------------------

const PGRST_NO_ROWS = "PGRST116";

function isMissing(error: { code?: string } | null): boolean {
  return !!error && error.code === PGRST_NO_ROWS;
}

function fail(op: string, error: { message?: string } | null): never {
  throw new Error(`eval store: ${op} failed: ${error?.message ?? "unknown error"}`);
}

function iso(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return new Date(value).toISOString();
}

// --- suites ----------------------------------------------------------------
interface SuiteRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

function rowToSuite(r: SuiteRow): EvalSuite {
  const suite: EvalSuite = { id: r.id, name: r.name };
  if (r.description != null) suite.description = r.description;
  return suite;
}

// --- cases -----------------------------------------------------------------
interface CaseRow {
  id: string;
  suite_id: string;
  label: string;
  stimulus: EvalFixtureCase["stimulus"];
  stages_to_run: EvalFixtureCase["stagesToRun"];
  expectations: EvalFixtureCase["expectations"] | null;
  artifacts: EvalFixtureArtifact[] | null;
  created_at: string;
}

function rowToCase(r: CaseRow): EvalFixtureCase {
  const evalCase: EvalFixtureCase = {
    id: r.id,
    suiteId: r.suite_id,
    label: r.label,
    stimulus: r.stimulus,
    stagesToRun: r.stages_to_run ?? [],
    artifacts: r.artifacts ?? [],
  };
  if (r.expectations != null) evalCase.expectations = r.expectations;
  return evalCase;
}

function caseToRow(c: EvalFixtureCase): CaseRow {
  return {
    id: c.id,
    suite_id: c.suiteId,
    label: c.label,
    stimulus: c.stimulus,
    stages_to_run: c.stagesToRun,
    expectations: c.expectations ?? null,
    artifacts: c.artifacts ?? [],
    created_at: new Date().toISOString(),
  };
}

// --- runs ------------------------------------------------------------------
interface RunRow {
  id: string;
  source: EvalRun["source"];
  suite_id: string | null;
  generation_mode: EvalRun["generationMode"];
  stop_after: EvalRun["stopAfter"] | null;
  git_sha: string;
  branch: string;
  judge_models: EvalRun["judgeModels"];
  status: EvalRun["status"];
  aggregate: EvalRun["aggregate"] | null;
  created_at: string;
  completed_at: string | null;
}

function rowToRun(r: RunRow): EvalRun {
  const run: EvalRun = {
    id: r.id,
    source: r.source,
    generationMode: r.generation_mode,
    gitSha: r.git_sha,
    branch: r.branch,
    judgeModels: r.judge_models ?? {},
    status: r.status,
    createdAt: iso(r.created_at),
  };
  if (r.suite_id != null) run.suiteId = r.suite_id;
  if (r.stop_after != null) run.stopAfter = r.stop_after;
  if (r.aggregate != null) run.aggregate = r.aggregate;
  if (r.completed_at != null) run.completedAt = iso(r.completed_at);
  return run;
}

function runToRow(run: EvalRun): RunRow {
  return {
    id: run.id,
    source: run.source,
    suite_id: run.suiteId ?? null,
    generation_mode: run.generationMode,
    stop_after: run.stopAfter ?? null,
    git_sha: run.gitSha,
    branch: run.branch,
    judge_models: run.judgeModels,
    status: run.status,
    aggregate: run.aggregate ?? null,
    created_at: run.createdAt,
    completed_at: run.completedAt ?? null,
  };
}

// --- judgments -------------------------------------------------------------
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
    grades: r.grades ?? {},
    verdict: r.verdict,
    rationale: r.rationale,
    trigger: r.trigger,
    costUsd: r.cost_usd ?? 0,
    latencyMs: r.latency_ms ?? 0,
    createdAt: iso(r.created_at),
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

// --- expectation results ---------------------------------------------------
interface ExpectationResultRow {
  eval_run_id: string;
  case_id: string;
  judgment_id: string;
  matched: boolean;
  detail: string | null;
}

function rowToExpectationResult(r: ExpectationResultRow): ExpectationResult {
  const result: ExpectationResult = {
    evalRunId: r.eval_run_id,
    caseId: r.case_id,
    judgmentId: r.judgment_id,
    matched: r.matched,
  };
  if (r.detail != null) result.detail = r.detail;
  return result;
}

function expectationResultToRow(e: ExpectationResult): ExpectationResultRow {
  return {
    eval_run_id: e.evalRunId,
    case_id: e.caseId,
    judgment_id: e.judgmentId,
    matched: e.matched,
    detail: e.detail ?? null,
  };
}

export function createSupabaseEvalStore(
  db: SupabaseClient = getServiceSupabase()
): EvalStore {
  return {
    async createSuite(input) {
      // Omit `id`; Postgres assigns it (gen_random_uuid) and we read it back.
      const { data, error } = await db
        .from("eval_suites")
        .insert({
          name: input.name,
          description: input.description ?? null,
          created_at: new Date().toISOString(),
        })
        .select("*")
        .single();
      if (error) fail("create suite", error);
      return rowToSuite(data as SuiteRow);
    },

    async getSuite(suiteId) {
      const { data, error } = await db
        .from("eval_suites")
        .select("*")
        .eq("id", suiteId)
        .single();
      if (error) {
        if (isMissing(error)) return null;
        fail("get suite", error);
      }
      return data ? rowToSuite(data as SuiteRow) : null;
    },

    async listSuites() {
      const { data, error } = await db
        .from("eval_suites")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) fail("list suites", error);
      return ((data as SuiteRow[]) ?? []).map(rowToSuite);
    },

    async saveCase(input) {
      const { id: _omit, ...row } = caseToRow({
        ...input,
        id: "",
        artifacts: input.artifacts ?? [],
      });
      void _omit;
      const { data, error } = await db
        .from("eval_cases")
        .insert(row)
        .select("*")
        .single();
      if (error) fail("save case", error);
      return rowToCase(data as CaseRow);
    },

    async getCase(caseId) {
      const { data, error } = await db
        .from("eval_cases")
        .select("*")
        .eq("id", caseId)
        .single();
      if (error) {
        if (isMissing(error)) return null;
        fail("get case", error);
      }
      return data ? rowToCase(data as CaseRow) : null;
    },

    async listCasesForSuite(suiteId) {
      const { data, error } = await db
        .from("eval_cases")
        .select("*")
        .eq("suite_id", suiteId)
        .order("created_at", { ascending: true });
      if (error) fail("list cases", error);
      return ((data as CaseRow[]) ?? []).map(rowToCase);
    },

    async saveRun(input) {
      const { id: _omit, ...row } = runToRow({
        ...input,
        id: "",
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
      void _omit;
      const { data, error } = await db
        .from("eval_runs")
        .insert(row)
        .select("*")
        .single();
      if (error) fail("save run", error);
      return rowToRun(data as RunRow);
    },

    async getRun(runId) {
      const { data, error } = await db
        .from("eval_runs")
        .select("*")
        .eq("id", runId)
        .single();
      if (error) {
        if (isMissing(error)) return null;
        fail("get run", error);
      }
      return data ? rowToRun(data as RunRow) : null;
    },

    async listRunsForSuite(suiteId) {
      const { data, error } = await db
        .from("eval_runs")
        .select("*")
        .eq("suite_id", suiteId)
        .order("created_at", { ascending: false });
      if (error) fail("list runs", error);
      return ((data as RunRow[]) ?? []).map(rowToRun);
    },

    async saveJudgment(judgment) {
      // Append-only: insert (never upsert) so re-judging appends a row. The id is
      // DB-generated (gen_random_uuid); omit it and read the assigned id back.
      const { id: _omit, ...row } = judgmentToRow({ ...judgment, id: "" });
      void _omit;
      const { data, error } = await db
        .from("judgments")
        .insert(row)
        .select("*")
        .single();
      if (error) fail("save judgment", error);
      return rowToJudgment(data as JudgmentRow);
    },

    async getJudgment(judgmentId) {
      const { data, error } = await db
        .from("judgments")
        .select("*")
        .eq("id", judgmentId)
        .single();
      if (error) {
        if (isMissing(error)) return null;
        fail("get judgment", error);
      }
      return data ? rowToJudgment(data as JudgmentRow) : null;
    },

    async listJudgmentsForRun(runId) {
      const { data, error } = await db
        .from("judgments")
        .select("*")
        .eq("eval_run_id", runId)
        .order("created_at", { ascending: true });
      if (error) fail("list judgments", error);
      return ((data as JudgmentRow[]) ?? []).map(rowToJudgment);
    },

    async saveExpectationResult(result) {
      const { error } = await db
        .from("expectation_results")
        .upsert(expectationResultToRow(result), { onConflict: "eval_run_id,judgment_id" });
      if (error) fail("save expectation result", error);
      return result;
    },

    async listExpectationResultsForRun(runId) {
      const { data, error } = await db
        .from("expectation_results")
        .select("*")
        .eq("eval_run_id", runId);
      if (error) fail("list expectation results", error);
      return ((data as ExpectationResultRow[]) ?? []).map(rowToExpectationResult);
    },
  };
}

// ---------------------------------------------------------------------------
// File-based implementation (offline unit tests / local dev without a DB)
// ---------------------------------------------------------------------------

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function createFileEvalStore(rootDir: string): EvalStore {
  function dir(collection: string): string {
    return path.join(rootDir, collection);
  }
  function file(collection: string, key: string): string {
    return path.join(dir(collection), `${safeKey(key)}.json`);
  }

  async function readJson<T>(collection: string, key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(file(collection, key), "utf8")) as T;
    } catch {
      return null;
    }
  }

  async function writeJson<T>(collection: string, key: string, value: T): Promise<T> {
    await fs.mkdir(dir(collection), { recursive: true });
    await fs.writeFile(file(collection, key), JSON.stringify(value, null, 2), "utf8");
    return value;
  }

  async function readAll<T>(collection: string): Promise<T[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir(collection));
    } catch {
      return [];
    }
    const records: T[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await fs.readFile(path.join(dir(collection), name), "utf8")) as T);
      } catch {
        // Skip unreadable/partial records rather than failing the whole list.
      }
    }
    return records;
  }

  return {
    async createSuite(input) {
      // File store stands in for the DB: it assigns the id (uuid) the same way
      // Postgres' gen_random_uuid default would.
      const suite: EvalSuite = { ...input, id: randomUUID() };
      await writeJson(COLLECTIONS.suites, suite.id, suite);
      return suite;
    },

    getSuite: (suiteId) => readJson<EvalSuite>(COLLECTIONS.suites, suiteId),

    async listSuites() {
      const all = await readAll<EvalSuite>(COLLECTIONS.suites);
      return all.sort((a, b) => (a.name < b.name ? -1 : 1));
    },

    async saveCase(input) {
      const evalCase: EvalFixtureCase = {
        ...input,
        id: randomUUID(),
        artifacts: input.artifacts ?? [],
      };
      await writeJson(COLLECTIONS.cases, evalCase.id, evalCase);
      return evalCase;
    },

    getCase: (caseId) => readJson<EvalFixtureCase>(COLLECTIONS.cases, caseId),

    async listCasesForSuite(suiteId) {
      const all = await readAll<EvalFixtureCase>(COLLECTIONS.cases);
      return all.filter((c) => c.suiteId === suiteId);
    },

    async saveRun(input) {
      const run: EvalRun = {
        ...input,
        id: randomUUID(),
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      await writeJson(COLLECTIONS.runs, run.id, run);
      return run;
    },

    getRun: (runId) => readJson<EvalRun>(COLLECTIONS.runs, runId),

    async listRunsForSuite(suiteId) {
      const all = await readAll<EvalRun>(COLLECTIONS.runs);
      return all
        .filter((r) => r.suiteId === suiteId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },

    async saveJudgment(judgment) {
      // Append-only: the store assigns a fresh id (uuid) on every insert, so
      // re-judging the same target appends a new record (never overwrites).
      const persisted: Judgment = { ...judgment, id: randomUUID() };
      await writeJson(COLLECTIONS.judgments, persisted.id, persisted);
      return persisted;
    },

    getJudgment: (judgmentId) => readJson<Judgment>(COLLECTIONS.judgments, judgmentId),

    async listJudgmentsForRun(runId) {
      const all = await readAll<Judgment>(COLLECTIONS.judgments);
      return all
        .filter((j) => j.evalRunId === runId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },

    async saveExpectationResult(result) {
      await writeJson(
        COLLECTIONS.expectationResults,
        `${result.evalRunId}_${result.judgmentId}`,
        result
      );
      return result;
    },

    async listExpectationResultsForRun(runId) {
      const all = await readAll<ExpectationResult>(COLLECTIONS.expectationResults);
      return all.filter((e) => e.evalRunId === runId);
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton selection
// ---------------------------------------------------------------------------

function localEvalRootDir(): string {
  return (
    process.env.POPCORN_READY_LOCAL_DIR ||
    path.join(process.cwd(), ".local")
  );
}

let _store: EvalStore | null = null;

export function getEvalStore(): EvalStore {
  if (_store) return _store;
  _store = useSupabaseStorage()
    ? createSupabaseEvalStore()
    : createFileEvalStore(path.join(localEvalRootDir(), "eval"));
  return _store;
}

// Hook for tests that need a deterministic store (mirrors the generation-runs
// store's setGenerationRunStoreForTests).
export function setEvalStoreForTests(store: EvalStore | null): void {
  _store = store;
}
