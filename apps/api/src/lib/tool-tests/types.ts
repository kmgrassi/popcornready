// Declarative "battery" format for manually testing orchestrator tool calls
// end-to-end against a real model and a real (throwaway) database. See README.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCallResult, ToolInvocationStatus, ToolName } from "@/lib/orchestrator";

export interface Sandbox {
  workspaceId: string;
  projectId: string;
  workspaceName: string;
}

export interface VerifyContext {
  /** The input the model supplied to the tool (post tool-call, pre-parse). */
  actualInput: Record<string, unknown>;
  /** The tool's result envelope, when a tool was called and executed. */
  result?: ToolCallResult;
  /** The throwaway workspace + project this case ran against. */
  sandbox: Sandbox;
  /** Service-role client for asserting persisted rows in the sandbox. */
  db: SupabaseClient;
}

export interface ToolTestExpectation {
  /** Tool the model is expected to call. Defaults to the battery's tool. */
  tool?: ToolName;
  /** Acceptable invocation status(es). Defaults to "succeeded". */
  callStatus?: ToolInvocationStatus | ToolInvocationStatus[];
  /** Deep-subset match against the model-supplied tool input. */
  input?: Record<string, unknown>;
  /** Deep-subset match against a succeeded tool's `output`. */
  output?: Record<string, unknown>;
}

export interface ToolTestCase {
  name: string;
  /** Natural-language instruction handed to the model as the turn's input. */
  instruction: string;
  /** "only" (default) exposes just the tool under test; "all" exposes the full vocabulary. */
  availableTools?: "only" | "all";
  /** Optional prior tool results to seed the model's context. */
  priorResults?: unknown[];
  /** "pending" cases are skipped (the tool is not wired yet). Defaults to "active". */
  status?: "active" | "pending";
  /**
   * Seed prerequisite graph state in the sandbox before the model turn runs
   * (e.g. a brief before plan_shots, a plan before generate_storyboard). Lets a
   * tool with a precondition be tested in isolation.
   */
  setup?: (ctx: { sandbox: Sandbox }) => Promise<void> | void;
  expect?: ToolTestExpectation;
  /** Custom assertion hook; return a list of failure strings ([] = pass). */
  verify?: (ctx: VerifyContext) => Promise<string[]> | string[];
}

export interface ToolBattery {
  tool: ToolName;
  cases: ToolTestCase[];
}

export interface AssertionResult {
  label: string;
  ok: boolean;
  detail?: string;
}

export type CaseStatus = "passed" | "failed" | "skipped" | "error";

export interface ToolTestCaseResult {
  tool: ToolName;
  case: string;
  status: CaseStatus;
  provider?: string;
  model?: string;
  toolCalled?: ToolName | null;
  actualInput?: unknown;
  resultStatus?: ToolInvocationStatus;
  assertions: AssertionResult[];
  errorMessage?: string;
  /** Present only when artifacts were kept (teardown skipped). */
  sandbox?: { workspaceId: string; projectId: string } | null;
}

export interface ToolTestReport {
  startedAt: string;
  finishedAt: string;
  provider: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  results: ToolTestCaseResult[];
}
