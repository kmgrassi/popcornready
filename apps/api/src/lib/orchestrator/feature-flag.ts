const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isOrchestratorToolLoopEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return ENABLED_VALUES.has(
    String(env.POPCORN_ORCHESTRATOR_TOOL_LOOP || "").trim().toLowerCase()
  );
}
