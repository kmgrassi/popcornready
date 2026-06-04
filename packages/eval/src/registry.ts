import type { Evaluator, GenerationStageType } from "./types";

export class EvaluatorRegistry {
  readonly #evaluators = new Map<string, Evaluator>();

  register(evaluator: Evaluator): void {
    if (this.#evaluators.has(evaluator.id)) {
      throw new Error(`Evaluator already registered: ${evaluator.id}`);
    }
    this.#evaluators.set(evaluator.id, evaluator);
  }

  get(id: string): Evaluator | undefined {
    return this.#evaluators.get(id);
  }

  list(): Evaluator[] {
    return [...this.#evaluators.values()];
  }

  forStage(stageType: GenerationStageType, tool?: string): Evaluator[] {
    return this.list().filter(
      (evaluator) =>
        evaluator.stageType === stageType &&
        (evaluator.tool == null || evaluator.tool === tool)
    );
  }
}
