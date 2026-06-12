import { randomUUID } from "node:crypto";

import {
  orchestratorModel,
  runToolLoopTurn,
  TOOL_NAMES,
  type OrchestratorRun,
  type ToolDefinition,
  type ToolName,
  type ToolRegistry,
} from "../src/lib/orchestrator";
import { getLlmClient, resolveLlmConfig, type LlmProvider } from "../src/lib/llm";

type ProviderArg = LlmProvider | "configured" | "all";

interface CliOptions {
  provider: ProviderArg;
  tool: ToolName | "all";
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    provider: "configured",
    tool: "all",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--provider" && next) {
      if (!["configured", "all", "openai", "anthropic"].includes(next)) {
        throw new Error(
          `Unknown --provider "${next}". Expected configured, all, openai, or anthropic.`
        );
      }
      options.provider = next as ProviderArg;
      i += 1;
      continue;
    }
    if (arg === "--tool" && next) {
      if (next !== "all" && !TOOL_NAMES.includes(next as ToolName)) {
        throw new Error(
          `Unknown --tool "${next}". Expected all or one of: ${TOOL_NAMES.join(", ")}.`
        );
      }
      options.tool = next as ToolName | "all";
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm --filter @popcorn/api smoke:tool-calls
  pnpm --filter @popcorn/api smoke:tool-calls -- --provider openai --tool plan_shots
  pnpm --filter @popcorn/api smoke:tool-calls -- --provider all

Options:
  --provider configured|openai|anthropic|all   LLM adapter to probe. Default: configured.
  --tool all|${TOOL_NAMES.join("|")}           Orchestrator tool to probe. Default: all.

This calls the real LLM provider with tool definitions, but executes only a
local probe handler that echoes the model's tool input.`);
}

function configuredProvider(): LlmProvider {
  return resolveLlmConfig(process.env).provider;
}

function providersFor(arg: ProviderArg): LlmProvider[] {
  if (arg === "all") return ["openai", "anthropic"];
  if (arg === "configured") return [configuredProvider()];
  return [arg];
}

function toolsFor(arg: ToolName | "all"): ToolName[] {
  return arg === "all" ? [...TOOL_NAMES] : [arg];
}

function nowIso(): string {
  return new Date().toISOString();
}

function runFixture(toolName: ToolName): OrchestratorRun {
  const now = nowIso();
  return {
    id: `orch_probe_${toolName}_${randomUUID()}`,
    projectId: "proj_tool_call_probe",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

function createProbeRegistry(toolName: ToolName, token: string): ToolRegistry {
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      projectId: {
        type: "string",
        enum: ["proj_tool_call_probe"],
        description: "Must be exactly proj_tool_call_probe.",
      },
      toolName: {
        type: "string",
        enum: [toolName],
        description: `Must be exactly ${toolName}.`,
      },
      confirmationToken: {
        type: "string",
        enum: [token],
        description: `Must be exactly ${token}.`,
      },
    },
    required: ["projectId", "toolName", "confirmationToken"],
  };

  const definition: ToolDefinition = {
    name: toolName,
    description: [
      `Manual end-to-end smoke probe for ${toolName}.`,
      "Call this tool exactly once using the exact required input values.",
      "Do not finish with text.",
    ].join(" "),
    inputSchema,
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    requiredResourceIds: [],
    mode: "sync",
    estimateCostUsd: () => undefined,
    execute: async (input) => ({
      status: "succeeded",
      resourceIds: [],
      output: { receivedInput: input },
    }),
  };

  return new Map([[toolName, definition]]);
}

function assertProbeInput(input: unknown, toolName: ToolName, token: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${toolName}: model supplied non-object tool input.`);
  }
  const actual = input as Record<string, unknown>;
  const expected = {
    projectId: "proj_tool_call_probe",
    toolName,
    confirmationToken: token,
  };
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${toolName}: expected input keys ${JSON.stringify(
        expectedKeys
      )}, got ${JSON.stringify(actualKeys)}. Full input: ${JSON.stringify(actual)}`
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(
        `${toolName}: expected input.${key}=${JSON.stringify(value)}, got ${JSON.stringify(
          actual[key]
        )}. Full input: ${JSON.stringify(actual)}`
      );
    }
  }
}

async function runProbe(provider: LlmProvider, toolName: ToolName): Promise<void> {
  const previousProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = provider;

  let result: Awaited<ReturnType<typeof runToolLoopTurn>>;
  const token = `probe_${toolName}_${randomUUID()}`;
  try {
    const registry = createProbeRegistry(toolName, token);
    const client = getLlmClient(process.env);
    result = await runToolLoopTurn({
      run: runFixture(toolName),
      workspaceId: "ws_tool_call_probe",
      actorId: "manual_smoke",
      requestId: `req_${randomUUID()}`,
      inputSummary: [
        `Manual tool-call probe for ${toolName}.`,
        `Call the only available tool, ${toolName}, exactly once.`,
        "Use this exact JSON input:",
        JSON.stringify({
          projectId: "proj_tool_call_probe",
          toolName,
          confirmationToken: token,
        }),
        "Do not answer in text.",
      ].join(" "),
      registry,
      model: async (input) => {
        if (client.provider !== provider) {
          throw new Error(`Resolved ${client.provider} client while probing ${provider}.`);
        }
        return orchestratorModel({ ...input, maxTokens: 1200 });
      },
      env: { ...process.env, POPCORN_ORCHESTRATOR_TOOL_LOOP: "1" },
    });
  } finally {
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previousProvider;
  }

  if (result.status !== "completed_turn") {
    throw new Error(`${toolName}: tool loop did not complete a turn.`);
  }
  const call = result.turn.toolCalls[0];
  if (!call) {
    throw new Error(`${toolName}: model finished without a tool call.`);
  }
  if (call.toolName !== toolName) {
    throw new Error(`${toolName}: expected tool ${toolName}, got ${call.toolName}.`);
  }
  assertProbeInput(call.input, toolName, token);
  if (call.status !== "succeeded") {
    throw new Error(`${toolName}: probe handler did not succeed, status=${call.status}.`);
  }

  console.log(
    [
      "ok",
      `provider=${provider}`,
      `model=${result.turn.model}`,
      `tool=${toolName}`,
      `input=${JSON.stringify(call.input)}`,
    ].join(" ")
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const providers = providersFor(options.provider);
  const tools = toolsFor(options.tool);

  console.log(
    `Running ${providers.length * tools.length} real LLM tool-call probe(s): providers=${providers.join(
      ","
    )} tools=${tools.join(",")}`
  );

  for (const provider of providers) {
    for (const tool of tools) {
      await runProbe(provider, tool);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
