import assert from "node:assert/strict";
import test from "node:test";

import { runToolTestSuite } from "../runner";
import type { ToolBattery } from "../types";

// A battery whose only case is pending — used to confirm the unmatched-filter
// guard fires BEFORE any sandbox/network work (validation precedes the sweep).
const battery: ToolBattery = {
  tool: "plan_shots",
  cases: [
    { name: "real case", instruction: "x", status: "pending", expect: { tool: "plan_shots" } },
  ],
};

test("runToolTestSuite rejects a caseName that matches nothing", async () => {
  await assert.rejects(
    () => runToolTestSuite({ batteries: [battery], caseName: "does-not-exist" }),
    /No tool-test case named "does-not-exist" for tool "plan_shots"/
  );
});
