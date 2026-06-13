import type { ToolBattery } from "../types";

// create_or_load_brief is the first DB-writing orchestrator tool. These cases
// run the real model → tool → INSERT and assert the persisted brief, and pin
// the invariant that out-of-schema agent input never reaches the database.
export const createOrLoadBriefBattery: ToolBattery = {
  tool: "create_or_load_brief",
  cases: [
    {
      name: "creates and persists a brief from a prompt",
      instruction:
        "Create the video brief for a 15-second, 9:16 social video. Goal: show a golden " +
        "retriever puppy learning to skateboard at a sunny skate park. Upbeat, playful style.",
      expect: {
        tool: "create_or_load_brief",
        callStatus: "succeeded",
        input: { aspectRatio: "9:16" },
      },
      verify: async ({ sandbox, db }) => {
        const failures: string[] = [];

        const { data: briefs, error: briefError } = await db
          .from("assets")
          .select("id, kind, media, role, content")
          .eq("project_id", sandbox.projectId)
          .eq("kind", "brief");
        if (briefError) failures.push(`asset query failed: ${briefError.message}`);
        if (!briefs || briefs.length === 0) {
          failures.push("no brief asset persisted for the sandbox project");
        } else if (briefs[0].media !== "data") {
          failures.push(`brief asset media expected "data", got "${briefs[0].media}"`);
        }

        const { data: selections, error: selError } = await db
          .from("selections")
          .select("id, active_asset_id, slot_role")
          .eq("project_id", sandbox.projectId)
          .eq("slot_role", "brief");
        if (selError) failures.push(`selection query failed: ${selError.message}`);
        if (!selections || selections.length === 0) {
          failures.push("no active brief selection was set");
        }

        return failures;
      },
    },
    {
      // The user's core worry: the agent supplies data the schema rejects. The
      // invariant is that such input is caught before the INSERT — either the
      // input guard rejects it (failed/invalid_input) or the model produces an
      // in-range value. It must NEVER persist an out-of-range duration.
      name: "never persists an out-of-range duration",
      instruction:
        "Create a brief for a 3-hour (10800 second) 16:9 documentary about deep-sea fish. " +
        "Set targetLengthSec to exactly 10800.",
      expect: {
        tool: "create_or_load_brief",
        callStatus: ["succeeded", "failed"],
      },
      verify: async ({ actualInput, result, sandbox, db }) => {
        const failures: string[] = [];
        const targetLengthSec = (actualInput as { targetLengthSec?: number }).targetLengthSec;
        const persisted = result?.status === "succeeded";

        if (
          persisted &&
          typeof targetLengthSec === "number" &&
          (targetLengthSec < 1 || targetLengthSec > 600)
        ) {
          failures.push(
            `out-of-range targetLengthSec=${targetLengthSec} was persisted; the guard should have rejected it`
          );
        }

        if (!persisted) {
          const { data } = await db
            .from("assets")
            .select("id")
            .eq("project_id", sandbox.projectId)
            .eq("kind", "brief");
          if ((data ?? []).length > 0) {
            failures.push("a brief asset was persisted despite the tool returning failed");
          }
        }

        return failures;
      },
    },
  ],
};
