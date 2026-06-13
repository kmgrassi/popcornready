// Naming guard for sandbox teardown. Kept dependency-free so it can be unit
// tested without pulling in the Supabase/store import chain.

export const TEST_WORKSPACE_PREFIX = "__tooltest__";

// Throws unless `name` is a harness-created sandbox workspace. teardown and the
// orphan sweeper both gate on this so the shared dev workspace (or any real
// workspace) can never be deleted by the harness.
export function assertDeletableSandboxName(name: string): void {
  if (!name || !name.startsWith(TEST_WORKSPACE_PREFIX)) {
    throw new Error(
      `Refusing to delete workspace "${name}": not a ${TEST_WORKSPACE_PREFIX} sandbox.`
    );
  }
}
