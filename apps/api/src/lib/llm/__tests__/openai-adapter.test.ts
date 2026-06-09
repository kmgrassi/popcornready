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
