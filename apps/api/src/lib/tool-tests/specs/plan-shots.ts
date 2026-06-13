import type { ToolBattery } from "../types";

// plan_shots is wired but does not write to the database — it calls planEdit and
// returns a structured plan. The verify hook checks the returned plan shape.
export const planShotsBattery: ToolBattery = {
  tool: "plan_shots",
  cases: [
    {
      name: "plans scenes and beats from a creative goal",
      instruction:
        "Plan the shots for a 20-second, 16:9, upbeat product video about a smart water " +
        "bottle that reminds you to drink. Break it into scenes and beats.",
      expect: {
        tool: "plan_shots",
        callStatus: "succeeded",
        input: { aspectRatio: "16:9" },
      },
      verify: ({ result }) => {
        const failures: string[] = [];
        const output =
          result?.status === "succeeded"
            ? (result.output as { plan?: { scenes?: unknown[] } } | undefined)
            : undefined;
        const scenes = output?.plan?.scenes;
        if (!Array.isArray(scenes) || scenes.length === 0) {
          failures.push("expected output.plan.scenes to be a non-empty array");
        }
        return failures;
      },
    },
  ],
};
