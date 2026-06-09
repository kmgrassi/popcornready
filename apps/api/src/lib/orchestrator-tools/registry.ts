import type {
  ToolCallResult,
  ToolCostEstimate,
  ToolDefinition,
  ToolExecutionContext,
  ToolName,
} from "./types";
import { ToolInputError } from "./types";

export class ToolRegistry {
  private readonly definitions = new Map<ToolName, ToolDefinition>();

  register(definition: ToolDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  get(name: ToolName): ToolDefinition {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return definition;
  }

  list(): ToolDefinition[] {
    return [...this.definitions.values()];
  }

  async estimateCost(
    name: ToolName,
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolCostEstimate> {
    const definition = this.get(name);
    const parsedInput = definition.parseInput(input);
    if (!definition.estimateCost) return {};
    return definition.estimateCost(parsedInput, context);
  }

  async execute(
    name: ToolName,
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolCallResult> {
    const definition = this.get(name);

    try {
      const parsedInput = definition.parseInput(input);
      return await definition.execute(parsedInput, context);
    } catch (error) {
      if (error instanceof ToolInputError) {
        return { status: "failed", error: error.toolError };
      }
      throw error;
    }
  }
}
