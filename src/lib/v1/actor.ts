// Actor/workspace resolution. PR1 owns the full hosted (Supabase + API key)
// implementation; PR4 only needs the local-mode resolution so generation jobs
// and timelines can be scoped to a workspace.

export interface Actor {
  actorId: string;
  workspaceId: string;
  agentClientId?: string;
  isLocal: boolean;
}

const LOCAL_ACTOR: Actor = {
  actorId: "local_dev",
  workspaceId: "dev_workspace",
  isLocal: true,
};

export function isLocalMode(): boolean {
  return (process.env.AUTH_MODE || "local") === "local";
}

// In AUTH_MODE=local the API bypasses auth and resolves to the deterministic
// dev actor/workspace. Hosted resolution is deferred to PR1.
export function resolveActor(): Actor {
  if (isLocalMode()) return LOCAL_ACTOR;
  // Hosted auth is not implemented in this PR. Treat as local for now so the
  // contract stays stable; PR1 replaces this with real token/key resolution.
  return LOCAL_ACTOR;
}
