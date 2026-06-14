// Runs a tool-test case end-to-end: real model → one tool → real DB write →
// assertions → teardown. Structurally mirrors scripts/orchestrator-tool-call-smoke.ts
// but drives real handlers and evaluates declarative expectations.

import { randomUUID } from "node:crypto";

import {
  orchestratorModel,
  runToolLoopTurn,
  type OrchestratorRun,
  type ToolInvocationStatus,
  type ToolLoopTurnResult,
} from "@/lib/orchestrator";
import { createDefaultToolRegistry } from "@/lib/orchestrator-tools/default-registry";
import type { ToolRegistry as RealToolRegistry } from "@/lib/orchestrator-tools/registry";
import { getServiceSupabase } from "@/lib/supabase/clients";
import { normalizeStatuses, subsetMismatches } from "./assertions";
import { toOrchestratorRegistry } from "./bridge";
import { createSandbox, sweepOrphanSandboxes, teardownSandbox } from "./sandbox";
import type {
  AssertionResult,
  Sandbox,
  ToolBattery,
  ToolTestCase,
  ToolTestCaseResult,
  ToolTestReport,
} from "./types";

export interface RunCaseOptions {
  /** "openai" | "anthropic" | "configured" (default). */
  provider?: string;
  /** Skip teardown and return the sandbox ids for inspection. */
  keepArtifacts?: boolean;
  /** Override the real tool registry (tests inject fakes). */
  realRegistry?: RealToolRegistry;
}

function nowIso(): string {
  return new Date().toISOString();
}

function failureDetail(turn: ToolLoopTurnResult): string {
  if (turn.status === "completed_turn" && turn.result?.status === "failed") {
    return ` error=${turn.result.error.message}`;
  }
  return "";
}

export async function runToolTestCase(
  battery: ToolBattery,
  testCase: ToolTestCase,
  options: RunCaseOptions = {}
): Promise<ToolTestCaseResult> {
  const expectedTool = testCase.expect?.tool ?? battery.tool;

  if (testCase.status === "pending") {
    return {
      tool: battery.tool,
      case: testCase.name,
      status: "skipped",
      assertions: [
        { label: "pending", ok: true, detail: `${battery.tool} is not wired yet.` },
      ],
    };
  }

  const provider =
    options.provider && options.provider !== "configured" ? options.provider : undefined;
  const previousProvider = process.env.LLM_PROVIDER;
  if (provider) process.env.LLM_PROVIDER = provider;

  const real = options.realRegistry ?? createDefaultToolRegistry();
  let sandbox: Sandbox | undefined;

  try {
    sandbox = await createSandbox();
    if (testCase.setup) await testCase.setup({ sandbox });
    const registry = toOrchestratorRegistry(
      real,
      testCase.availableTools === "all" ? { includeStubs: true } : { only: battery.tool }
    );

    const run: OrchestratorRun = {
      id: `orch_tooltest_${randomUUID()}`,
      projectId: sandbox.projectId,
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const turn = await runToolLoopTurn({
      run,
      workspaceId: sandbox.workspaceId,
      actorId: "tool_test",
      requestId: `req_${randomUUID()}`,
      inputSummary: testCase.instruction,
      priorResults: testCase.priorResults,
      registry,
      model: orchestratorModel,
      env: { ...process.env, POPCORN_ORCHESTRATOR_TOOL_LOOP: "1" },
    });

    const completedTurn = turn.status === "completed_turn" ? turn.turn : undefined;
    const call = completedTurn?.toolCalls[0];
    const toolCalled = call?.toolName ?? null;
    const resultStatus = call?.status;

    const assertions: AssertionResult[] = [];

    assertions.push({
      label: `calls ${expectedTool}`,
      ok: toolCalled === expectedTool,
      detail: toolCalled
        ? `model called ${toolCalled}`
        : completedTurn
          ? "model finished without calling a tool"
          : "no turn completed (loop disabled?)",
    });

    if (call) {
      const expectedStatuses = normalizeStatuses(testCase.expect?.callStatus ?? "succeeded");
      assertions.push({
        label: `status ∈ {${expectedStatuses.join(", ")}}`,
        ok: expectedStatuses.includes(call.status),
        detail: `actual=${call.status}${failureDetail(turn)}`,
      });

      if (testCase.expect?.input) {
        const mismatches = subsetMismatches(call.input, testCase.expect.input);
        assertions.push({
          label: "input matches",
          ok: mismatches.length === 0,
          detail: mismatches.join("; ") || "ok",
        });
      }

      if (testCase.expect?.output) {
        const output =
          turn.status === "completed_turn" && turn.result?.status === "succeeded"
            ? turn.result.output
            : undefined;
        const mismatches = subsetMismatches(output, testCase.expect.output);
        assertions.push({
          label: "output matches",
          ok: mismatches.length === 0,
          detail: mismatches.join("; ") || "ok",
        });
      }
    }

    if (testCase.verify) {
      const failures = await testCase.verify({
        actualInput: (call?.input ?? {}) as Record<string, unknown>,
        result: turn.status === "completed_turn" ? turn.result : undefined,
        sandbox,
        db: getServiceSupabase(),
      });
      assertions.push({
        label: "verify",
        ok: failures.length === 0,
        detail: failures.join("; ") || "ok",
      });
    }

    const passed = assertions.every((assertion) => assertion.ok);
    return {
      tool: battery.tool,
      case: testCase.name,
      status: passed ? "passed" : "failed",
      provider: options.provider ?? "configured",
      model: completedTurn?.model,
      toolCalled,
      actualInput: call?.input,
      resultStatus: resultStatus as ToolInvocationStatus | undefined,
      assertions,
      sandbox: options.keepArtifacts
        ? { workspaceId: sandbox.workspaceId, projectId: sandbox.projectId }
        : null,
    };
  } catch (error) {
    return {
      tool: battery.tool,
      case: testCase.name,
      status: "error",
      provider: options.provider ?? "configured",
      assertions: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (sandbox && !options.keepArtifacts) {
      try {
        await teardownSandbox(sandbox);
      } catch {
        // best-effort; the orphan sweeper reclaims anything left behind.
      }
    }
    if (provider) {
      if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = previousProvider;
    }
  }
}

export interface RunSuiteOptions extends RunCaseOptions {
  batteries: ToolBattery[];
  /** Only run a single case by name (across the selected batteries). */
  caseName?: string;
}

export async function runToolTestSuite(
  options: RunSuiteOptions
): Promise<ToolTestReport> {
  // Resolve the cases to run up front. A caseName that matches nothing is an
  // error, not an empty (and falsely green) run — otherwise a misspelled filter
  // looks like a passing verification when zero cases executed.
  const planned: { battery: ToolBattery; testCase: ToolTestCase }[] = [];
  for (const battery of options.batteries) {
    for (const testCase of battery.cases) {
      if (options.caseName && testCase.name !== options.caseName) continue;
      planned.push({ battery, testCase });
    }
  }
  if (options.caseName && planned.length === 0) {
    const scope =
      options.batteries.length === 1 ? ` for tool "${options.batteries[0].tool}"` : "";
    throw new Error(`No tool-test case named "${options.caseName}"${scope}.`);
  }

  // Reclaim sandboxes from any crashed prior runs before starting.
  await sweepOrphanSandboxes().catch(() => 0);

  const startedAt = nowIso();
  const results: ToolTestCaseResult[] = [];

  for (const { battery, testCase } of planned) {
    results.push(
      await runToolTestCase(battery, testCase, {
        provider: options.provider,
        keepArtifacts: options.keepArtifacts,
        realRegistry: options.realRegistry,
      })
    );
  }

  const tally = (status: ToolTestCaseResult["status"]) =>
    results.filter((result) => result.status === status).length;

  return {
    startedAt,
    finishedAt: nowIso(),
    provider: options.provider ?? "configured",
    total: results.length,
    passed: tally("passed"),
    failed: tally("failed"),
    skipped: tally("skipped"),
    errored: tally("error"),
    results,
  };
}
