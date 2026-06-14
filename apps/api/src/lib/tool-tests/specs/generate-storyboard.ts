import { agentApiStore } from "@/lib/agent-api/jobs";
import {
  addProjectBrief,
  addProjectPlan,
  getActiveProjectBrief,
} from "@/lib/api/v1/store";
import type { ToolBattery } from "../types";

// Poll the inline-run job until it reaches a terminal state (the worker is
// fire-and-forget, so the accepted turn returns before the tiles are written).
async function pollJob(jobId: string, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const job = await agentApiStore.getJob(jobId);
    if (job && (job.status === "succeeded" || job.status === "failed")) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

// generate_storyboard reads the active plan, generates one sketch tile per beat,
// persists each as an image asset (recording the plan as input), and builds the
// relational storyboard. Async: the turn returns `accepted`; the worker finishes
// out-of-band. Uses the mock tile provider so the battery is deterministic/free.
export const generateStoryboardBattery: ToolBattery = {
  tool: "generate_storyboard",
  cases: [
    {
      name: "requires a plan before sketching",
      instruction: "Sketch the storyboard for this project's video.",
      expect: { tool: "generate_storyboard", callStatus: "failed" },
      verify: ({ result }) => {
        const failures: string[] = [];
        if (result?.status !== "failed") {
          failures.push(`expected a failed result, got ${result?.status}`);
          return failures;
        }
        if (result.error.kind !== "precondition_unmet") {
          failures.push(`expected precondition_unmet, got ${result.error.kind}`);
        }
        const suggests = (result.error.unmetRequirements ?? []).some(
          (r) => r.satisfyWith.tool === "plan_shots"
        );
        if (!suggests) failures.push("expected the miss to suggest plan_shots");
        return failures;
      },
    },
    {
      name: "generates tiles + relational storyboard from the plan",
      instruction: "Sketch the storyboard for this project's video.",
      // Seed the prerequisite brief + plan, and pin the mock tile provider.
      setup: async ({ sandbox }) => {
        process.env.STORYBOARD_TILE_PROVIDER = "mock";
        await addProjectBrief({
          workspaceId: sandbox.workspaceId,
          projectId: sandbox.projectId,
          brief: {
            goal: "A golden retriever puppy learns to skateboard at a sunny skate park.",
            targetLengthSec: 15,
            aspectRatio: "9:16",
            style: "upbeat, playful",
          },
        });
        const brief = await getActiveProjectBrief(sandbox.projectId);
        await addProjectPlan({
          workspaceId: sandbox.workspaceId,
          projectId: sandbox.projectId,
          ...(brief
            ? { briefAssetId: brief.assetId, briefContentHash: brief.contentHash }
            : {}),
          plan: {
            targetLengthSec: 15,
            style: "upbeat, playful",
            aspectRatio: "9:16",
            scenes: [
              {
                id: "scene_1",
                name: "Open at the skate park",
                beats: [
                  { id: "beat_1", name: "Hook", durationSec: 5, intent: "Introduce the puppy." },
                  { id: "beat_2", name: "Payoff", durationSec: 10, intent: "Puppy lands the trick." },
                ],
              },
            ],
          },
        });
      },
      // An `accepted` result is recorded as the "waiting_for_job" invocation status.
      expect: { tool: "generate_storyboard", callStatus: "waiting_for_job" },
      verify: async ({ result, sandbox, db }) => {
        const failures: string[] = [];
        if (result?.status !== "accepted") {
          failures.push(`expected accepted, got ${result?.status}`);
          return failures;
        }

        const job = await pollJob(result.jobId);
        if (!job) {
          failures.push("storyboard job never reached a terminal state");
          return failures;
        }
        if (job.status !== "succeeded") {
          failures.push(`job ended ${job.status}: ${JSON.stringify(job.error)}`);
          return failures;
        }
        const tileAssetIds = (job.result as { assetIds?: string[] } | undefined)?.assetIds ?? [];
        if (tileAssetIds.length !== 2) {
          failures.push(`expected one tile per beat (2), got ${tileAssetIds.length}`);
        }

        // The plan the tiles derive from.
        const { data: plans } = await db
          .from("assets")
          .select("id")
          .eq("project_id", sandbox.projectId)
          .eq("kind", "plan");
        const planId = plans?.[0]?.id as string | undefined;

        // Relational storyboard linked to the plan, with a panel per beat.
        const { data: storyboards } = await db
          .from("storyboards")
          .select("id, plan_asset_id")
          .eq("project_id", sandbox.projectId);
        if (!storyboards || storyboards.length === 0) {
          failures.push("no storyboard row was created");
        } else if (planId && storyboards[0].plan_asset_id !== planId) {
          failures.push("storyboard is not linked to the active plan asset");
        }

        const { data: panels } = await db
          .from("storyboard_panels")
          .select("image_asset_id")
          .eq("project_id", sandbox.projectId);
        if (!panels || panels.length !== 2) {
          failures.push(`expected one selected panel per beat (2), got ${panels?.length ?? 0}`);
        }

        // Provenance: each tile records the plan as its input (tile → plan edge),
        // so replacing the plan/brief marks the storyboard stale.
        if (planId && tileAssetIds.length) {
          const { data: edges } = await db
            .from("asset_edges")
            .select("from_id, to_id")
            .eq("project_id", sandbox.projectId)
            .eq("to_id", planId)
            .in("from_id", tileAssetIds);
          if (!edges || edges.length < tileAssetIds.length) {
            failures.push("missing tile → plan asset_edges (stale-candidates would miss the tiles)");
          }
        }

        return failures;
      },
    },
  ],
};
