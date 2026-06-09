import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiLlmClient,
  interpretOpenAiToolResponse,
  sanitizeForOpenAI,
  toOpenAITool,
} from "../openai";
import type { ToolSpec } from "../types";

const planShots: ToolSpec = {
  name: "plan_shots",
  description: "Plan scenes and beats.",
  parameters: {
    type: "object",
    properties: { goal: { type: "string", minLength: 1 } },
    required: ["goal"],
  },
};

test("toOpenAITool wraps the spec as an OpenAI function tool", () => {
  const tool = toOpenAITool(planShots) as any;
  assert.equal(tool.type, "function");
  assert.equal(tool.function.name, "plan_shots");
  assert.equal(tool.function.description, "Plan scenes and beats.");
  assert.deepEqual(tool.function.parameters, planShots.parameters);
});

test("sanitizeForOpenAI strips keywords OpenAI json_schema rejects", () => {
  const sanitized = sanitizeForOpenAI({
    type: "object",
    properties: {
      goal: { type: "string", minLength: 1, maxLength: 5 },
      n: { type: "number", minimum: 1, maximum: 600 },
    },
    required: ["goal"],
  }) as any;
  assert.equal(sanitized.properties.goal.minLength, undefined);
  assert.equal(sanitized.properties.goal.maxLength, undefined);
  assert.equal(sanitized.properties.n.minimum, undefined);
  assert.equal(sanitized.properties.n.maximum, undefined);
  // structural keywords are preserved
  assert.equal(sanitized.properties.goal.type, "string");
  assert.deepEqual(sanitized.required, ["goal"]);
});

test("interpretOpenAiToolResponse maps one tool_call with JSON-parsed arguments", () => {
  const decision = interpretOpenAiToolResponse(
    {
      model: "gpt-5",
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "plan_shots", arguments: '{"goal":"a diner"}' } },
            ],
          },
        },
      ],
    },
    "fallback"
  );
  assert.equal(decision.type, "tool_call");
  if (decision.type === "tool_call") {
    assert.equal(decision.toolName, "plan_shots");
    assert.deepEqual(decision.input, { goal: "a diner" });
    assert.equal(decision.model, "gpt-5");
  }
});

test("interpretOpenAiToolResponse takes the first of parallel tool_calls", () => {
  const decision = interpretOpenAiToolResponse(
    {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "plan_shots", arguments: "{}" } },
              { function: { name: "generate_clip", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    "m"
  );
  assert.equal(decision.type, "tool_call");
  if (decision.type === "tool_call") assert.equal(decision.toolName, "plan_shots");
});

test("interpretOpenAiToolResponse returns done with text when no tool is called", () => {
  const decision = interpretOpenAiToolResponse(
    { choices: [{ message: { content: "All complete." } }] },
    "m"
  );
  assert.equal(decision.type, "done");
  if (decision.type === "done") assert.equal(decision.text, "All complete.");
});

test("chooseTool sends function tools + tool_choice auto and uses max_completion_tokens", async () => {
  let sent: any;
  const client = createOpenAiLlmClient({
    model: "gpt-5",
    create: async (params) => {
      sent = params;
      return {
        model: "gpt-5",
        choices: [
          {
            message: {
              tool_calls: [{ function: { name: "plan_shots", arguments: '{"goal":"x"}' } }],
            },
          },
        ],
      };
    },
  });

  const decision = await client.chooseTool({
    system: "sys",
    userPayload: { a: 1 },
    tools: [planShots],
  });

  assert.equal(sent.tool_choice, "auto");
  assert.equal(sent.tools[0].type, "function");
  assert.equal(sent.tools[0].function.name, "plan_shots");
  assert.ok("max_completion_tokens" in sent);
  assert.ok(!("max_tokens" in sent));
  assert.equal(decision.type, "tool_call");
});

test("low/minimal effort routes to the fast model; medium/high/none use the primary", async () => {
  const seen: string[] = [];
  const client = createOpenAiLlmClient({
    model: "gpt-5",
    fastModel: "gpt-5-mini",
    create: async (params: any) => {
      seen.push(params.model);
      return { choices: [{ message: { content: "{}" } }] };
    },
  });
  for (const effort of ["minimal", "low", "medium", "high"] as const) {
    await client.structured({ cachedSystem: "s", user: "u", schema: {}, effort });
  }
  await client.structured({ cachedSystem: "s", user: "u", schema: {} });
  assert.deepEqual(seen, ["gpt-5-mini", "gpt-5-mini", "gpt-5", "gpt-5", "gpt-5"]);
});

test("reasoning_effort is sent for reasoning models (gpt-5) and omitted for gpt-4o", async () => {
  let reasoning: any;
  const gpt5 = createOpenAiLlmClient({
    model: "gpt-5",
    create: async (params) => {
      reasoning = params;
      return { choices: [{ message: { content: "{}" } }] };
    },
  });
  await gpt5.structured({ cachedSystem: "s", user: "u", schema: {}, effort: "minimal" });
  assert.equal(reasoning.reasoning_effort, "minimal");

  let nonReasoning: any;
  const gpt4o = createOpenAiLlmClient({
    model: "gpt-4o",
    create: async (params) => {
      nonReasoning = params;
      return { choices: [{ message: { content: "{}" } }] };
    },
  });
  await gpt4o.structured({ cachedSystem: "s", user: "u", schema: {}, effort: "high" });
  assert.ok(!("reasoning_effort" in nonReasoning));

  // No effort -> no reasoning_effort (provider default).
  let noEffort: any;
  const gpt5b = createOpenAiLlmClient({
    model: "gpt-5",
    create: async (params) => {
      noEffort = params;
      return { choices: [{ message: { content: "{}" } }] };
    },
  });
  await gpt5b.structured({ cachedSystem: "s", user: "u", schema: {} });
  assert.ok(!("reasoning_effort" in noEffort));
});

test("structured parses message content as JSON and throws on invalid output", async () => {
  const ok = createOpenAiLlmClient({
    model: "gpt-5",
    create: async () => ({ choices: [{ message: { content: '{"plan":1}' } }] }),
  });
  assert.deepEqual(
    await ok.structured({ cachedSystem: "s", user: "u", schema: {} }),
    { plan: 1 }
  );

  const bad = createOpenAiLlmClient({
    model: "gpt-5",
    create: async () => ({ choices: [{ message: { content: "not json" } }] }),
  });
  await assert.rejects(
    () => bad.structured({ cachedSystem: "s", user: "u", schema: {} }),
    /did not return valid JSON/
  );
});
