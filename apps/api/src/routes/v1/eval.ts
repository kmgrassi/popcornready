import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import {
  diffRuns,
  getRunDetail,
  getSuiteDetail,
  judgeArtifact,
  listSuites,
  startSuiteRun,
} from "@/lib/eval/service";

// v1 HTTP surface for the stage eval framework (docs/scopes/stage-eval-framework.md
// §6B suite dashboard, §6C on-demand judge). Eval entities are global admin/tooling
// records (no workspace/project tenancy), but routes still run through route()/
// mutation() so they share the v1 auth + error envelope contract.
export const evalRouter = Router();

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function requireParam(params: Record<string, string | undefined>, name: string): string {
  const value = params[name];
  if (!value) {
    throw new ApiError("validation_failed", `${name} is required.`);
  }
  return value;
}

function requireStringField(body: unknown, field: string): string {
  if (!body || typeof body !== "object") {
    throw new ApiError("validation_failed", "Request body must be a JSON object.");
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError("validation_failed", `${field} is required.`, {
      fields: [{ path: field, message: `${field} must be a non-empty string.` }],
    });
  }
  return value;
}

function optionalStringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError("validation_failed", `${field} must be a string.`, {
      fields: [{ path: field, message: `${field} must be a string.` }],
    });
  }
  return value;
}

// GET /api/v1/eval/suites — suite list for the dashboard.
evalRouter.get(
  "/eval/suites",
  route(async () => {
    const suites = await listSuites();
    return { status: 200, body: { suites }, headers: NO_STORE_HEADERS };
  })
);

// GET /api/v1/eval/suites/:suiteId — one suite + its cases.
evalRouter.get(
  "/eval/suites/:suiteId",
  route(async (_ctx, params) => {
    const suiteId = requireParam(params, "suiteId");
    const detail = await getSuiteDetail(suiteId);
    return { status: 200, body: detail, headers: NO_STORE_HEADERS };
  })
);

// GET /api/v1/eval/runs/:runId — run + its cases + judgments (dashboard grid).
evalRouter.get(
  "/eval/runs/:runId",
  route(async (_ctx, params) => {
    const runId = requireParam(params, "runId");
    const detail = await getRunDetail(runId);
    return { status: 200, body: detail, headers: NO_STORE_HEADERS };
  })
);

// GET /api/v1/eval/runs/:runId/diff?against=:otherRunId — verdict flips.
evalRouter.get(
  "/eval/runs/:runId/diff",
  route(async ({ req }, params) => {
    const runId = requireParam(params, "runId");
    const against = req.searchParams.get("against");
    if (!against) {
      throw new ApiError("validation_failed", "against query parameter is required.", {
        fields: [{ path: "against", message: "Provide the run id to diff against." }],
      });
    }
    const diff = await diffRuns(runId, against);
    return { status: 200, body: diff, headers: NO_STORE_HEADERS };
  })
);

// POST /api/v1/eval/runs — start an eval run for a suite.
evalRouter.post(
  "/eval/runs",
  mutation(async ({ body }) => {
    const suiteId = requireStringField(body, "suiteId");
    const detail = await startSuiteRun({
      suiteId,
      gitSha: optionalStringField(body, "gitSha"),
      branch: optionalStringField(body, "branch"),
    });
    return { status: 202, body: detail };
  })
);

// POST /api/v1/eval/judgments — on-demand single-artifact judge (scope §6C).
evalRouter.post(
  "/eval/judgments",
  mutation(async ({ body }) => {
    const evaluatorId = requireStringField(body, "evaluatorId");
    const artifactId = requireStringField(body, "artifactId");
    const judgment = await judgeArtifact({ evaluatorId, artifactId });
    return { status: 201, body: { judgment } };
  })
);
