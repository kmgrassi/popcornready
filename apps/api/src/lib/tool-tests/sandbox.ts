// Throwaway workspace + project lifecycle for end-to-end tool tests. Each case
// runs against its own sandbox so real INSERTs are exercised and then fully
// removed. Teardown deletes the workspace; FK cascades remove its projects,
// assets, actions, edges, and selections in one statement.

import { randomUUID } from "node:crypto";

import { createProject, ensureLocalWorkspace } from "@/lib/api/v1/store";
import { getServiceSupabase } from "@/lib/supabase/clients";
import { assertDeletableSandboxName, TEST_WORKSPACE_PREFIX } from "./sandbox-guard";
import type { Sandbox } from "./types";

export { TEST_WORKSPACE_PREFIX, assertDeletableSandboxName } from "./sandbox-guard";

// Create a uniquely-named sandbox workspace (unowned, matched by name) plus an
// empty project for tools to write into.
export async function createSandbox(): Promise<Sandbox> {
  const workspaceName = `${TEST_WORKSPACE_PREFIX}${randomUUID()}`;
  const workspace = await ensureLocalWorkspace(workspaceName);
  const { project } = await createProject({
    workspaceId: workspace.id,
    name: "tool-test sandbox project",
  });
  return { workspaceId: workspace.id, projectId: project.id, workspaceName };
}

// Delete the sandbox workspace (cascades to everything under it). Guarded twice:
// the name must carry the test prefix, and the DELETE itself is constrained to
// rows whose name matches the prefix.
export async function teardownSandbox(sandbox: Sandbox): Promise<void> {
  assertDeletableSandboxName(sandbox.workspaceName);
  const db = getServiceSupabase();
  const { error } = await db
    .from("workspaces")
    .delete()
    .eq("id", sandbox.workspaceId)
    .like("name", `${TEST_WORKSPACE_PREFIX}%`);
  if (error) {
    throw new Error(`teardownSandbox failed: ${error.message}`);
  }
}

// Remove any sandbox workspaces left behind by crashed runs. Returns the count
// deleted. Run at the start of a suite.
export async function sweepOrphanSandboxes(): Promise<number> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("workspaces")
    .delete()
    .like("name", `${TEST_WORKSPACE_PREFIX}%`)
    .select("id");
  if (error) {
    throw new Error(`sweepOrphanSandboxes failed: ${error.message}`);
  }
  return data?.length ?? 0;
}
