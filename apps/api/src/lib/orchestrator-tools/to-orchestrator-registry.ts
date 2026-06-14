// Adapts the rich `orchestrator-tools` registry (parseInput/execution shape,
// auth-context execution) into the `orchestrator` driver/engine registry shape
// (mode/requiredResourceIds, workspace-context execution) so the real tool
// handlers can be driven by the orchestrator model + executeRegisteredTool.
//
// This is the canonical, production bridge — the orchestrator engine is its real
// consumer. The tool-test harness's lib/tool-tests/bridge.ts re-exports it.

import type { AuthContext } from "@/lib/api/v1/auth";
import {
  createToolRegistry,
  type ToolDefinition as OrchestratorToolDefinition,
  type ToolExecutionContext as OrchestratorContext,
  type ToolName,
  type ToolRegistry as OrchestratorRegistry,
} from "@/lib/orchestrator";
import type { ToolRegistry as RealToolRegistry } from "./registry";

// The driver/engine context carries a workspaceId + optional actorId; the real
// tools expect a full AuthContext. Synthesize a local-mode identity (the
// orchestrator runs as a trusted server process against a real project).
function bridgeContext(context: OrchestratorContext): {
  auth: AuthContext;
  projectId?: string;
  orchestratorRunId?: string;
} {
  const auth: AuthContext = {
    mode: "local",
    actor: { id: context.actorId ?? "orchestrator", type: "local" },
    workspaceId: context.workspaceId,
    isLocal: true,
  };
  return {
    auth,
    projectId: context.projectId,
    orchestratorRunId: context.orchestratorRunId,
  };
}

function bridgeTool(real: RealToolRegistry, name: ToolName): OrchestratorToolDefinition {
  const definition = real.get(name);
  return {
    name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    requiredResourceIds: [],
    mode: definition.execution,
    estimateCostUsd: () => undefined,
    // Delegate to the registry's execute (which runs parseInput + maps
    // ToolInputError to a failed result) so validation matches production.
    execute: (input, context) => real.execute(name, input, bridgeContext(context)),
  };
}

export interface ToOrchestratorRegistryOptions {
  /** Expose only this one tool (harness single-tool isolation). */
  only?: ToolName;
  /**
   * Also fill the rest of the vocabulary with declared driver stubs. Off by
   * default: the engine should only offer tools that are actually wired. The
   * harness turns this on to test the model's tool *selection* across all 14.
   */
  includeStubs?: boolean;
}

export function toOrchestratorRegistry(
  real: RealToolRegistry,
  options: ToOrchestratorRegistryOptions = {}
): OrchestratorRegistry {
  if (options.only) {
    return new Map([[options.only, bridgeTool(real, options.only)]]);
  }

  if (options.includeStubs) {
    const registry = createToolRegistry();
    for (const definition of real.list()) {
      registry.set(definition.name, bridgeTool(real, definition.name));
    }
    return registry;
  }

  // Default: only the wired tools.
  return new Map(real.list().map((definition) => [definition.name, bridgeTool(real, definition.name)]));
}
