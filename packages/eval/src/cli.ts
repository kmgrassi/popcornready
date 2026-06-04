#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { EvaluatorRegistry } from "./registry";
import { runEvalSuite } from "./runner";
import type { EvalSuiteFixture, Evaluator } from "./types";

interface CliArgs {
  fixturePath: string;
  evaluatorModulePath: string;
  outPath?: string;
  gitSha: string;
  branch: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(await readFile(args.fixturePath, "utf8")) as EvalSuiteFixture;
  const registry = new EvaluatorRegistry();
  for (const evaluator of await loadEvaluators(args.evaluatorModulePath)) {
    registry.register(evaluator);
  }

  const result = await runEvalSuite({
    registry,
    fixture,
    gitSha: args.gitSha,
    branch: args.branch,
  });

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.outPath) {
    await writeFile(args.outPath, json);
  } else {
    process.stdout.write(json);
  }
}

async function loadEvaluators(modulePath: string): Promise<Evaluator[]> {
  const mod = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    default?: Evaluator[] | EvaluatorRegistry;
    evaluators?: Evaluator[];
    registerEvaluators?: (registry: EvaluatorRegistry) => void | Promise<void>;
  };

  if (mod.default instanceof EvaluatorRegistry) {
    return mod.default.list();
  }
  if (Array.isArray(mod.default)) {
    return mod.default;
  }
  if (Array.isArray(mod.evaluators)) {
    return mod.evaluators;
  }
  if (mod.registerEvaluators) {
    const registry = new EvaluatorRegistry();
    await mod.registerEvaluators(registry);
    return registry.list();
  }

  throw new Error(
    "Evaluator module must export default Evaluator[], evaluators, or registerEvaluators(registry)"
  );
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    values.set(arg.slice(2), value);
    i += 1;
  }

  const fixturePath = values.get("fixture");
  const evaluatorModulePath = values.get("evaluators");
  if (!fixturePath || !evaluatorModulePath) {
    throw new Error(
      "Usage: popcorn-eval --fixture suite.json --evaluators evaluators.ts [--out result.json] [--git-sha SHA] [--branch NAME]"
    );
  }

  return {
    fixturePath,
    evaluatorModulePath,
    outPath: values.get("out"),
    gitSha: values.get("git-sha") ?? "unknown",
    branch: values.get("branch") ?? "unknown",
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
