// Manual end-to-end driver for the autonomous orchestrator engine. Creates a
// throwaway sandbox project, starts an orchestrator run from a prompt, drives it
// to completion against the REAL LLM + REAL DB, prints the action timeline, then
// tears the sandbox down (unless --keep).
//
//   pnpm --filter @popcorn/api orchestrator:run -- --prompt "make a 15s 9:16 video about a skateboarding puppy"
//   pnpm --filter @popcorn/api orchestrator:run -- --prompt "..." --gates create_or_load_brief
//   pnpm --filter @popcorn/api orchestrator:run -- --prompt "..." --provider anthropic --budget 1.5 --keep
//
// Requires local secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, an LLM key) and
// the migration applied (orchestrator_runs / orchestrator_run_gates).

import { randomUUID } from "node:crypto";

import { createProject, ensureLocalWorkspace } from "../src/lib/api/v1/store";
import {
  createOrchestratorRun,
  listRunActions,
  listRunGates,
} from "../src/lib/api/v1/orchestrator-store";
import { runOrchestratorToCompletion } from "../src/lib/orchestrator/engine";
import { getServiceSupabase } from "../src/lib/supabase/clients";

const SANDBOX_PREFIX = "__orchrun__";

interface CliOptions {
  prompt: string;
  gates: string[];
  provider?: string;
  budgetUsd?: number;
  keep: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { prompt: "", gates: [], keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "--prompt":
        options.prompt = next ?? "";
        i += 1;
        break;
      case "--gates":
        options.gates = (next ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case "--provider":
        options.provider = next;
        i += 1;
        break;
      case "--budget":
        options.budgetUsd = Number(next);
        i += 1;
        break;
      case "--keep":
        options.keep = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.prompt) throw new Error("Missing required --prompt.");
  return options;
}

async function teardown(workspaceId: string, workspaceName: string): Promise<void> {
  if (!workspaceName.startsWith(SANDBOX_PREFIX)) return; // guard: never delete a real workspace
  const db = getServiceSupabase();
  await db
    .from("workspaces")
    .delete()
    .eq("id", workspaceId)
    .like("name", `${SANDBOX_PREFIX}%`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.provider) process.env.LLM_PROVIDER = options.provider;

  const workspaceName = `${SANDBOX_PREFIX}${randomUUID()}`;
  const workspace = await ensureLocalWorkspace(workspaceName);
  const { project } = await createProject({
    workspaceId: workspace.id,
    name: "orchestrator-run demo",
  });

  try {
    const run = await createOrchestratorRun({
      projectId: project.id,
      inputSummary: options.prompt,
      gates: options.gates,
      budgetUsd: options.budgetUsd,
    });
    console.log(
      `run ${run.id}  project=${project.id}  gates=[${options.gates.join(", ")}]` +
        `${options.budgetUsd != null ? `  budget=$${options.budgetUsd}` : ""}`
    );

    const final = await runOrchestratorToCompletion(run.id, { workspaceId: workspace.id });

    const actions = await listRunActions(run.id);
    const gates = await listRunGates(run.id);

    console.log(`\nstatus: ${final.status}${final.error ? `  error=${JSON.stringify(final.error)}` : ""}`);
    console.log("timeline:");
    if (actions.length === 0) console.log("  (no tool calls executed)");
    for (const action of actions) {
      console.log(
        `  • ${action.tool}  [${action.status}]` +
          `${action.outputAssetIds.length ? `  →assets ${action.outputAssetIds.join(",")}` : ""}` +
          `${action.error ? `  error=${JSON.stringify(action.error)}` : ""}`
      );
    }
    if (gates.length) {
      console.log("gates:");
      for (const gate of gates) console.log(`  • ${gate.stage}  [${gate.status}]`);
    }
  } finally {
    if (options.keep) {
      console.log(`\nkept sandbox workspace=${workspace.id} project=${project.id}`);
    } else {
      await teardown(workspace.id, workspaceName);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
