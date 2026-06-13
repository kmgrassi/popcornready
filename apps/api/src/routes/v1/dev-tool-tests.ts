// Dev-only endpoint that drives the orchestrator tool-call test harness. Mounted
// (in public-routes.ts) ONLY when isToolTestHarnessEnabled() is true, so it is
// flag-gated and never reachable in production. No auth — the harness manages
// its own throwaway, sandboxed workspaces. See lib/tool-tests/README.md.

import { Router, type RequestHandler } from "express";
import { ApiError } from "@/core/errors";
import { createDefaultToolRegistry } from "@/lib/orchestrator-tools/default-registry";
import { listBatteries } from "@/lib/tool-tests/batteries";
import { runToolTestSuite } from "@/lib/tool-tests/runner";
import type { ToolName } from "@/lib/orchestrator";
import type { ToolBattery } from "@/lib/tool-tests/types";

export function isToolTestHarnessEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const flag = String(env.ENABLE_TOOL_TEST_HARNESS || "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true";
  return enabled && env.NODE_ENV !== "production";
}

export const devToolTestsRouter = Router();

function devRoute(
  fn: (req: Parameters<RequestHandler>[0]) => Promise<{ status: number; body: unknown }>
): RequestHandler {
  return async (req, res) => {
    try {
      const result = await fn(req);
      res.status(result.status).json(result.body);
    } catch (err) {
      const apiError =
        err instanceof ApiError
          ? err
          : new ApiError(
              "internal_error",
              err instanceof Error ? err.message : "Internal error."
            );
      res.status(apiError.status).json(apiError.envelope(req.requestId));
    }
  };
}

// GET /api/v1/dev/tool-tests — list the available batteries and which tools are
// wired to a live handler.
devToolTestsRouter.get(
  "/dev/tool-tests",
  devRoute(async () => {
    const wired = new Set(createDefaultToolRegistry().list().map((tool) => tool.name));
    const batteries = listBatteries().map((battery) => ({
      tool: battery.tool,
      wired: wired.has(battery.tool),
      cases: battery.cases.map((testCase) => ({
        name: testCase.name,
        status: testCase.status ?? "active",
        availableTools: testCase.availableTools ?? "only",
      })),
    }));
    return { status: 200, body: { batteries } };
  })
);

// POST /api/v1/dev/tool-tests/run — run selected cases end-to-end and return a
// report. Body: { tool?, case?, provider?, keepArtifacts? }.
devToolTestsRouter.post(
  "/dev/tool-tests/run",
  devRoute(async (req) => {
    const body = (req.body ?? {}) as {
      tool?: string;
      case?: string;
      provider?: string;
      keepArtifacts?: boolean;
    };

    let batteries: ToolBattery[];
    if (body.tool) {
      const match = listBatteries().find((battery) => battery.tool === (body.tool as ToolName));
      if (!match) {
        throw new ApiError("not_found", `No tool-test battery for tool "${body.tool}".`);
      }
      batteries = [match];
    } else {
      batteries = listBatteries();
    }

    const report = await runToolTestSuite({
      batteries,
      caseName: body.case,
      provider: body.provider,
      keepArtifacts: body.keepArtifacts === true,
    });

    return { status: 200, body: report };
  })
);
