import assert from "node:assert/strict";
import test from "node:test";

import {
  createAnthropicLlmClient,
  interpretAnthropicToolResponse,
  toAnthropicTool,
} from "../anthropic";
import type { ToolSpec } from "../types";

const planShots: ToolSpec = {
  name: "plan_shots",
  description: "Plan scenes and beats.",
  parameters: {
    type: "object",
    properties: { goal: { type: "string" } },
    required: ["goal"],
  },
};

test("toAnthropicTool uses input_schema", () => {
  const tool = toAnthropicTool(planShots) as any;
  assert.equal(tool.name, "plan_shots");
  assert.equal(tool.description, "Plan scenes and beats.");
  assert.deepEqual(tool.input_schema, planShots.parameters);
});

test("interpretAnthropicToolResponse maps a single tool_use block", () => {
  const decision = interpretAnthropicToolResponse(
    { model: "claude-x", content: [{ type: "tool_use", name: "plan_shots", input: { goal: "y" } }] },
    "fallback"
  );
  assert.equal(decision.type, "tool_call");
  if (decision.type === "tool_call") {
    assert.equal(decision.toolName, "plan_shots");
    assert.deepEqual(decision.input, { goal: "y" });
    assert.equal(decision.model, "claude-x");
  }
});

test("interpretAnthropicToolResponse throws on more than one tool_use", () => {
  assert.throws(
    () =>
      interpretAnthropicToolResponse(
        {
          content: [
            { type: "tool_use", name: "a", input: {} },
            { type: "tool_use", name: "b", input: {} },
          ],
        },
        "fb"
      ),
    /more than one tool call/
  );
});

test("interpretAnthropicToolResponse returns done with joined text when no tool is used", () => {
  const decision = interpretAnthropicToolResponse(
    { content: [{ type: "text", text: "done " }, { type: "text", text: "here" }] },
    "fb"
  );
  assert.equal(decision.type, "done");
  if (decision.type === "done") assert.equal(decision.text, "done here");
});

test("interpretAnthropicToolResponse rejects a tool the registry does not allow", () => {
  assert.throws(
    () =>
      interpretAnthropicToolResponse(
        { content: [{ type: "tool_use", name: "bogus", input: {} }] },
        "fb",
        new Set(["plan_shots"])
      ),
    /unknown tool/i
  );
});

test("chooseTool sends input_schema tools + tool_choice auto and maps the result", async () => {
  let sent: any;
  const client = createAnthropicLlmClient({
    model: "claude-x",
    createMessage: async (params) => {
      sent = params;
      return {
        model: "claude-x",
        content: [{ type: "tool_use", name: "plan_shots", input: { goal: "z" } }],
      };
    },
  });

  const decision = await client.chooseTool({
    system: "sys",
    userPayload: { a: 1 },
    tools: [planShots],
  });

  assert.deepEqual(sent.tool_choice, { type: "auto" });
  assert.equal(sent.tools[0].input_schema.type, "object");
  assert.equal(sent.max_tokens, 2000);
  assert.equal(decision.type, "tool_call");
  if (decision.type === "tool_call") assert.equal(decision.toolName, "plan_shots");
});
