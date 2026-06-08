// P1 granular generation: the story/plan stage as its own endpoint.
//
// docs/scopes/granular-generation-api.md §3 (Plan / Plan-critique / Replan) and
// §6 (resolved decisions). This is a deliberately THIN wrapper around the
// `planEdit` / `critiquePlan` agent calls — it does NOT touch the shared engine
// (apps/api/src/lib/v1/generation.ts); engine unification is a later PR (§6.5).
//
// Decisions honored here:
//  - §6.2 Uniform async: every endpoint returns a pollable Job. plan/critique
//    are a single synchronous LLM call, so we create the Job in its terminal
//    state once the work is done; it is then pollable via the GET companions.
//  - §6.3 Strict typed precondition errors: a missing/ambiguous input throws a
//    structured ApiError (validation_failed) BEFORE any work — not a wrong
//    result — so an agent caller can self-heal.
//  - §6.4 Plan persists by default: the generated beats are saved as a
//    `composition` in the pool unless `persist: false`.
//
// The handlers take their store + agent dependencies via an injectable `deps`
// object (defaults wire the real implementations). This keeps the module
// framework-free and unit-testable without a live Supabase, mirroring the
// dependency-injection style of lib/v1/generation.ts.

import {
  planEdit as realPlanEdit,
  critiquePlan as realCritiquePlan,
} from "@/lib/agent";
import { briefToStoryContext } from "@/lib/v1/generation/prepare";
import type {
  EditPlan,
  PlanCritiqueReport,
  StoryContext,
} from "@popcorn/shared/types";
import type {
  CompositionPlan,
  PlannedBeat,
} from "@popcorn/shared/v1/types";
import { SCHEMA as CONTRACT_SCHEMA } from "@popcorn/shared/v1/types";
import { AuthContext } from "./auth";
import { ApiError, FieldError, validationError } from "./errors";
import { VideoBrief } from "./schemas";
import {
  createBriefVersion,
  createJob,
  getCompositionPlan,
  getJob,
  getProject,
  listBriefVersions,
  saveCompositionPlan,
} from "./store";

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

// Injectable seam so handlers can be unit-tested without a live Supabase / a
// real Anthropic call. Defaults wire the real implementations.
export interface PlanDeps {
  planEdit: typeof realPlanEdit;
  critiquePlan: typeof realCritiquePlan;
  createBriefVersion: typeof createBriefVersion;
  listBriefVersions: typeof listBriefVersions;
  saveCompositionPlan: typeof saveCompositionPlan;
  getCompositionPlan: typeof getCompositionPlan;
  createJob: typeof createJob;
  getJob: typeof getJob;
  getProject: typeof getProject;
}

const defaultDeps: PlanDeps = {
  planEdit: realPlanEdit,
  critiquePlan: realCritiquePlan,
  createBriefVersion,
  listBriefVersions,
  saveCompositionPlan,
  getCompositionPlan,
  createJob,
  getJob,
  getProject,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ASPECT_RATIOS = new Set(["9:16", "16:9", "1:1"]);

function parseAspectRatio(value: unknown, fields: FieldError[]): EditPlan["aspectRatio"] {
  const raw = value === undefined ? "9:16" : String(value);
  if (!ASPECT_RATIOS.has(raw)) {
    fields.push({
      path: "aspectRatio",
      message: "Must be one of: 9:16, 16:9, 1:1.",
    });
    return "9:16";
  }
  return raw as EditPlan["aspectRatio"];
}

function parseTargetLength(value: unknown, fields: FieldError[]): number {
  if (value === undefined) return 30;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > 600
  ) {
    fields.push({
      path: "targetLengthSec",
      message: "Must be a number between 1 and 600.",
    });
    return 30;
  }
  return value;
}

// EditPlan beats → composition PlannedBeats. A bare plan has no asset bindings
// yet (no media generated — §3), so every beat starts at generate_video; the
// beat-scoped media tools (P2) flip these as assets land.
function beatsToPlannedBeats(plan: EditPlan): PlannedBeat[] {
  return plan.beats.map((beat) => ({
    name: beat.name,
    intent: beat.intent,
    durationSec: beat.durationSec,
    assetStrategy: "generate_video",
  }));
}

async function persistPlanAsComposition(
  deps: PlanDeps,
  auth: AuthContext,
  projectId: string,
  briefVersionId: string,
  plan: EditPlan
): Promise<CompositionPlan> {
  const now = new Date().toISOString();
  const composition: CompositionPlan = {
    // Placeholder; saveCompositionPlan omits the id so Postgres assigns it.
    id: "",
    schemaVersion: CONTRACT_SCHEMA.composition,
    projectId,
    briefVersionId,
    // A plain plan has no asset selection yet, and it is not media-ready.
    mode: "prompt_only",
    status: "planning",
    plannedBeats: beatsToPlannedBeats(plan),
    generatedAssetJobIds: [],
    readyAssetIds: [],
    createdAt: now,
    updatedAt: now,
  };
  return deps.saveCompositionPlan(auth.workspaceId, composition);
}

// Resolve the planning inputs (goal/length/style/aspect/storyContext) from
// either an inline `prompt` (a brief is created for it — §3) or an existing
// `briefVersionId`. A prior `plan` + `feedback` (replan, §3) is folded into the
// goal so planEdit re-plans with the feedback in context.
interface PlanInputs {
  goal: string;
  targetLengthSec: number;
  style: string;
  aspectRatio: EditPlan["aspectRatio"];
  storyContext: StoryContext | null;
  briefVersionId: string;
}

// Resolve a brief version by id, paging through every revision. `listBriefVersions`
// is the only read path and returns a single page, so a valid older id beyond the
// first page must not surface as a false `not_found`.
async function findBriefVersionById(
  deps: PlanDeps,
  workspaceId: string,
  projectId: string,
  briefVersionId: string
) {
  let cursor: string | null = null;
  do {
    const page = await deps.listBriefVersions(workspaceId, projectId, 200, cursor);
    const found = page.items.find((v) => v.id === briefVersionId);
    if (found) return found;
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

async function resolvePlanInputs(
  deps: PlanDeps,
  auth: AuthContext,
  projectId: string,
  body: Record<string, unknown>
): Promise<PlanInputs> {
  const fields: FieldError[] = [];
  const prompt =
    typeof body.prompt === "string" ? body.prompt.trim() : "";
  const briefVersionId =
    typeof body.briefVersionId === "string" ? body.briefVersionId.trim() : "";

  if (prompt && briefVersionId) {
    throw validationError("The request body is invalid.", [
      {
        path: "prompt",
        message: "Provide either prompt or briefVersionId, not both.",
      },
    ]);
  }

  // Strict typed precondition (§6.3): need an input to plan from.
  if (!prompt && !briefVersionId) {
    throw new ApiError(
      "validation_failed",
      "A prompt or briefVersionId is required to plan a story.",
      {
        fields: [
          {
            path: "prompt",
            message: "Provide a prompt, or reference an existing briefVersionId.",
          },
        ],
      }
    );
  }

  const style =
    typeof body.style === "string" && body.style.trim()
      ? body.style.trim()
      : "fast-paced social ad";
  const aspectRatio = parseAspectRatio(body.aspectRatio, fields);
  const targetLengthSec = parseTargetLength(body.targetLengthSec, fields);

  const inlineStoryContext =
    body.storyContext !== undefined && body.storyContext !== null
      ? isPlainObject(body.storyContext)
        ? (body.storyContext as StoryContext)
        : (() => {
            fields.push({
              path: "storyContext",
              message: "Must be an object.",
            });
            return null;
          })()
      : null;

  // Replan (§3): a prior plan + feedback re-runs planning with the feedback.
  const priorPlan =
    body.plan !== undefined && body.plan !== null
      ? isPlainObject(body.plan)
        ? (body.plan as unknown as EditPlan)
        : (() => {
            fields.push({ path: "plan", message: "Must be an object." });
            return null;
          })()
      : null;
  const feedback =
    typeof body.feedback === "string" ? body.feedback.trim() : "";

  if (fields.length) {
    throw validationError("The request body is invalid.", fields);
  }

  if (briefVersionId) {
    // Resolve the version by id, paging through all revisions (not just the
    // first page) so an older briefVersionId is not a false not_found.
    const version = await findBriefVersionById(
      deps,
      auth.workspaceId,
      projectId,
      briefVersionId
    );
    if (!version) {
      throw new ApiError(
        "not_found",
        `Brief version not found: ${briefVersionId}.`
      );
    }
    const brief = version.brief;
    return {
      goal: composeGoal(brief.goal, priorPlan, feedback),
      targetLengthSec:
        body.targetLengthSec !== undefined
          ? targetLengthSec
          : brief.targetLengthSec,
      style:
        body.style !== undefined ? style : brief.style || style,
      aspectRatio:
        body.aspectRatio !== undefined
          ? aspectRatio
          : (brief.aspectRatio as EditPlan["aspectRatio"]),
      storyContext: inlineStoryContext ?? briefToStoryContext(brief),
      briefVersionId,
    };
  }

  // Inline prompt: persist a brief version for it (§3 "If prompt, create a
  // brief version first").
  const brief: VideoBrief = {
    goal: prompt,
    targetLengthSec,
    aspectRatio,
    style,
  };
  const { briefVersion } = await deps.createBriefVersion(
    auth.workspaceId,
    projectId,
    brief
  );
  return {
    goal: composeGoal(prompt, priorPlan, feedback),
    targetLengthSec,
    style,
    aspectRatio,
    storyContext: inlineStoryContext ?? briefToStoryContext(brief),
    briefVersionId: briefVersion.id,
  };
}

function composeGoal(
  base: string,
  priorPlan: EditPlan | null,
  feedback: string
): string {
  if (!priorPlan && !feedback) return base;
  const parts = [base];
  if (priorPlan) {
    parts.push(
      "\nPrevious plan beats:",
      ...priorPlan.beats.map(
        (b) => `  - ${b.name} (~${b.durationSec}s): ${b.intent}`
      )
    );
  }
  if (feedback) {
    parts.push(`\nRevise the plan per this feedback: ${feedback}`);
  }
  return parts.join("\n");
}

export interface CreatePlanArgs {
  auth: AuthContext;
  projectId: string;
  body: unknown;
  deps?: Partial<PlanDeps>;
}

export async function createPlan(args: CreatePlanArgs): Promise<ApiResult> {
  const deps = { ...defaultDeps, ...args.deps };
  const { auth, projectId } = args;

  await deps.getProject(auth.workspaceId, projectId); // throws not_found
  const body = isPlainObject(args.body) ? args.body : {};

  const inputs = await resolvePlanInputs(deps, auth, projectId, body);

  const plan = await deps.planEdit({
    goal: inputs.goal,
    targetLengthSec: inputs.targetLengthSec,
    style: inputs.style,
    aspectRatio: inputs.aspectRatio,
    storyContext: inputs.storyContext,
  });

  // Persist as a composition by default (§6.4); persist:false skips.
  const persist = body.persist !== false;
  let compositionId: string | undefined;
  if (persist) {
    const composition = await persistPlanAsComposition(
      deps,
      auth,
      projectId,
      inputs.briefVersionId,
      plan
    );
    compositionId = composition.id;
  }

  // Uniform async (§6.2): hand back a pollable Job. The work is already done, so
  // the job is created in its terminal succeeded state.
  const job = await deps.createJob({
    workspaceId: auth.workspaceId,
    projectId,
    type: "composition",
    status: "succeeded",
    payload: {
      kind: "plan",
      briefVersionId: inputs.briefVersionId,
      persisted: persist,
    },
    result: compositionId ? { plan, compositionId } : { plan },
  });

  return { status: 202, body: { job } };
}

export interface CritiquePlanArgs {
  auth: AuthContext;
  projectId: string;
  body: unknown;
  deps?: Partial<PlanDeps>;
}

export async function createPlanCritique(
  args: CritiquePlanArgs
): Promise<ApiResult> {
  const deps = { ...defaultDeps, ...args.deps };
  const { auth, projectId } = args;

  await deps.getProject(auth.workspaceId, projectId); // throws not_found
  const body = isPlainObject(args.body) ? args.body : {};

  const fields: FieldError[] = [];
  const compositionId =
    typeof body.compositionId === "string" ? body.compositionId.trim() : "";
  const inlinePlan =
    body.plan !== undefined && body.plan !== null
      ? isPlainObject(body.plan)
        ? (body.plan as unknown as EditPlan)
        : (() => {
            fields.push({ path: "plan", message: "Must be an object." });
            return null;
          })()
      : null;

  if (!compositionId && !inlinePlan) {
    // Strict typed precondition (§6.3).
    throw new ApiError(
      "validation_failed",
      "A compositionId or plan is required to critique a plan.",
      {
        fields: [
          {
            path: "plan",
            message: "Provide a plan, or reference a persisted compositionId.",
          },
        ],
      }
    );
  }

  const style =
    typeof body.style === "string" && body.style.trim()
      ? body.style.trim()
      : "fast-paced social ad";
  const aspectRatio = parseAspectRatio(body.aspectRatio, fields);
  if (fields.length) {
    throw validationError("The request body is invalid.", fields);
  }

  let plan: EditPlan;
  // The metadata actually used for the critique. When critiquing a persisted
  // composition without an explicit style/aspectRatio, recover them from the
  // composition's brief so a 16:9 / cinematic plan is not silently re-cast as
  // the request defaults (fast-paced social ad / 9:16) in the revised plan.
  let effectiveStyle = style;
  let effectiveAspectRatio = aspectRatio;
  if (inlinePlan) {
    plan = inlinePlan;
  } else {
    const composition = await deps.getCompositionPlan(
      auth.workspaceId,
      projectId,
      compositionId
    );
    if (
      (body.style === undefined || body.aspectRatio === undefined) &&
      composition.briefVersionId
    ) {
      const version = await findBriefVersionById(
        deps,
        auth.workspaceId,
        projectId,
        composition.briefVersionId
      );
      const brief = version?.brief;
      if (brief) {
        if (body.style === undefined && brief.style) {
          effectiveStyle = brief.style;
        }
        if (body.aspectRatio === undefined && brief.aspectRatio) {
          effectiveAspectRatio = brief.aspectRatio as EditPlan["aspectRatio"];
        }
      }
    }
    plan = compositionToEditPlan(composition, effectiveStyle, effectiveAspectRatio);
  }

  const goal =
    typeof body.goal === "string" && body.goal.trim()
      ? body.goal.trim()
      : plan.beats.map((b) => b.intent).join(" ");

  const report: PlanCritiqueReport = await deps.critiquePlan({
    goal,
    plan,
    style: effectiveStyle,
    aspectRatio: effectiveAspectRatio,
  });

  const job = await deps.createJob({
    workspaceId: auth.workspaceId,
    projectId,
    type: "composition",
    status: "succeeded",
    payload: { kind: "plan_critique", compositionId: compositionId || undefined },
    result: { report },
  });

  return { status: 202, body: { job } };
}

function compositionToEditPlan(
  composition: CompositionPlan,
  style: string,
  aspectRatio: EditPlan["aspectRatio"]
): EditPlan {
  return {
    targetLengthSec: composition.plannedBeats.reduce(
      (sum, b) => sum + (b.durationSec || 0),
      0
    ),
    style,
    aspectRatio,
    beats: composition.plannedBeats.map((b) => ({
      name: b.name,
      intent: b.intent,
      durationSec: b.durationSec,
    })),
  };
}

export interface GetPlanJobArgs {
  auth: AuthContext;
  projectId: string;
  jobId: string;
  deps?: Partial<PlanDeps>;
}

export async function getPlanJob(args: GetPlanJobArgs): Promise<ApiResult> {
  const deps = { ...defaultDeps, ...args.deps };
  const { auth, projectId, jobId } = args;
  await deps.getProject(auth.workspaceId, projectId); // throws not_found
  const job = await deps.getJob(auth.workspaceId, projectId, jobId);
  if (job.type !== "composition") {
    throw new ApiError("not_found", `Plan job not found: ${jobId}.`);
  }
  return { status: 200, body: { job } };
}
