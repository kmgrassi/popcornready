// Pure assertion helpers for the tool-test harness. No I/O — unit tested directly.

import type { ToolInvocationStatus } from "@/lib/orchestrator";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Returns a list of human-readable mismatches where `actual` fails to contain
// the `expected` subtree. Objects are matched as subsets (extra actual keys are
// fine); arrays must match length and each element as a subset; primitives are
// compared with strict equality. [] means actual satisfies expected.
export function subsetMismatches(
  actual: unknown,
  expected: unknown,
  path = ""
): string[] {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return [`${path || "<root>"}: expected object, got ${describe(actual)}`];
    }
    const out: string[] = [];
    for (const [key, value] of Object.entries(expected)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in actual)) {
        out.push(`${childPath}: missing (expected ${describe(value)})`);
        continue;
      }
      out.push(...subsetMismatches(actual[key], value, childPath));
    }
    return out;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [`${path || "<root>"}: expected array, got ${describe(actual)}`];
    }
    if (actual.length !== expected.length) {
      return [
        `${path || "<root>"}: expected array length ${expected.length}, got ${actual.length}`,
      ];
    }
    const out: string[] = [];
    expected.forEach((value, index) => {
      out.push(...subsetMismatches(actual[index], value, `${path}[${index}]`));
    });
    return out;
  }

  if (actual !== expected) {
    return [`${path || "<root>"}: expected ${describe(expected)}, got ${describe(actual)}`];
  }
  return [];
}

export function normalizeStatuses(
  expected: ToolInvocationStatus | ToolInvocationStatus[]
): ToolInvocationStatus[] {
  return Array.isArray(expected) ? expected : [expected];
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
