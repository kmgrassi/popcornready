import { Router } from "express";
import { mutation, route } from "@/core/adapter";
import { ApiError } from "@/core/errors";
import { bearerToken } from "@/lib/api/v1/auth";
import type { HandlerCtx } from "@/lib/api/v1/handler";
import {
  diffRuns,
  getRunDetail,
  getSuiteDetail,
  judgeArtifact,
  listSuites,
  startSuiteRun,
} from "@/lib/eval/service";
import { buildUserScopedSupabase } from "@/lib/supabase/clients";

// v1 HTTP surface for the stage eval framework (docs/scopes/stage-eval-framework.md
// §6B suite dashboard, §6C on-demand judge). Eval entities are global admin/tooling
// records (no workspace/project tenancy), but routes still run through route()/
// mutation() so they share the v1 auth + error envelope contract.
export const evalRouter = Router();

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const ADMIN_ROLES = new Set(["admin", "owner"]);

function claimValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function hasAdminAppMetadata(appMetadata: Record<string, unknown> | undefined): boolean {
  if (!appMetadata) return false;
  const claims = [
    ...claimValues(appMetadata.role),
    ...claimValues(appMetadata.roles),
    ...claimValues(appMetadata.workspace_role),
  ];
  return claims.some((claim) => ADMIN_ROLES.has(claim.toLowerCase()));
}

async function requireEvalAdmin(ctx: Pick<HandlerCtx, "auth" | "req">): Promise<void> {
  if (ctx.auth.isLocal) return;

  const token = bearerToken(ctx.req);
  if (!token) {
    throw new ApiError("forbidden", "Eval admin access required.");
  }

  const supabase = buildUserScopedSupabase(token);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user || !hasAdminAppMetadata(data.user.app_metadata)) {
    throw new ApiError("forbidden", "Eval admin access required.");
  }
}

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
  route(async (ctx) => {
    await requireEvalAdmin(ctx);
    const suites = await listSuites();
    return { status: 200, body: { suites }, headers: NO_STORE_HEADERS };
  })
);

// GET /api/v1/eval/suites/:suiteId — one suite + its cases.
evalRouter.get(
  "/eval/suites/:suiteId",
  route(async (ctx, params) => {
    await requireEvalAdmin(ctx);
    const suiteId = requireParam(params, "suiteId");
    const detail = await getSuiteDetail(suiteId);
    return { status: 200, body: detail, headers: NO_STORE_HEADERS };
  })
);

// GET /api/v1/eval/runs/:runId — run + its cases + judgments (dashboard grid).
evalRouter.get(
  "/eval/runs/:runId",
  route(async (ctx, params) => {
    await requireEvalAdmin(ctx);
    const runId = requireParam(params, "runId");
    const detail = await getRunDetail(runId);
    return { status: 200, body: detail, headers: NO_STORE_HEADERS };
  })
);

// GET /api/v1/eval/runs/:runId/diff?against=:otherRunId — verdict flips.
evalRouter.get(
  "/eval/runs/:runId/diff",
  route(async (ctx, params) => {
    await requireEvalAdmin(ctx);
    const runId = requireParam(params, "runId");
    const against = ctx.req.searchParams.get("against");
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
  mutation(async (ctx) => {
    await requireEvalAdmin(ctx);
    const { body } = ctx;
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
  mutation(async (ctx) => {
    await requireEvalAdmin(ctx);
    const { body } = ctx;
    const evaluatorId = requireStringField(body, "evaluatorId");
    const artifactId = requireStringField(body, "artifactId");
    const judgment = await judgeArtifact({ evaluatorId, artifactId });
    return { status: 201, body: { judgment } };
  })
);
