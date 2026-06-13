import { addProjectBrief } from "@/lib/api/v1/store";
import type { ToolBattery } from "../types";

// plan_shots now reads the project's brief (precondition), derives the plan from
// it, and persists the plan as the active 'plan' asset. These cases prove both
// the precondition path and the real graph write.
export const planShotsBattery: ToolBattery = {
  tool: "plan_shots",
  cases: [
    {
      name: "requires a brief before planning",
      instruction: "Plan the scenes and beats for this project's video.",
      expect: {
        tool: "plan_shots",
        callStatus: "failed",
      },
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
          (r) => r.satisfyWith.tool === "create_or_load_brief"
        );
        if (!suggests) failures.push("expected the miss to suggest create_or_load_brief");
        return failures;
      },
    },
    {
      name: "plans from the brief and persists the plan",
      instruction: "Plan the scenes and beats for this project's video.",
      // Seed the prerequisite brief the way create_or_load_brief would.
      setup: async ({ sandbox }) => {
        await addProjectBrief({
          workspaceId: sandbox.workspaceId,
          projectId: sandbox.projectId,
          brief: {
            goal: "Show a golden retriever puppy learning to skateboard at a sunny skate park.",
            targetLengthSec: 15,
            aspectRatio: "9:16",
            style: "upbeat, playful",
          },
        });
      },
      expect: {
        tool: "plan_shots",
        callStatus: "succeeded",
      },
      verify: async ({ sandbox, db }) => {
        const failures: string[] = [];

        const { data: plans, error: planError } = await db
          .from("assets")
          .select("id, kind, media")
          .eq("project_id", sandbox.projectId)
          .eq("kind", "plan");
        if (planError) failures.push(`asset query failed: ${planError.message}`);
        if (!plans || plans.length === 0) {
          failures.push("no plan asset persisted for the sandbox project");
        } else if (plans[0].media !== "data") {
          failures.push(`plan asset media expected "data", got "${plans[0].media}"`);
        }

        const { data: selections, error: selError } = await db
          .from("selections")
          .select("id, slot_role")
          .eq("project_id", sandbox.projectId)
          .eq("slot_role", "plan");
        if (selError) failures.push(`selection query failed: ${selError.message}`);
        if (!selections || selections.length === 0) {
          failures.push("no active plan selection was set");
        }

        return failures;
      },
    },
  ],
};
