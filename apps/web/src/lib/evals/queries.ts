import { useQuery, type QueryFunctionContext } from "@tanstack/react-query";
import { ApiClientError } from "../api-client";
import {
  evalApi,
  toRunDetail,
  toSuiteSummary,
  type EvalRunDetailView,
  type EvalSuiteSummaryView,
  type VerdictFlip,
} from "./api";
import {
  fallbackEvalSuites,
  fallbackRunDetails,
  fallbackVerdictFlips,
} from "./fallback";

type QuerySignal = QueryFunctionContext["signal"];

export const evalQueryKeys = {
  suites: (authScope: string) => ["evals", authScope, "suites"] as const,
  runDetail: (authScope: string, source: "api" | "fallback", runId: string) =>
    ["evals", authScope, "runs", source, runId] as const,
  runDiff: (
    authScope: string,
    source: "api" | "fallback",
    runId: string,
    againstRunId: string,
  ) => ["evals", authScope, "runs", source, runId, "diff", againstRunId] as const,
};

export interface EvalSuitesQueryData {
  suites: EvalSuiteSummaryView[];
  usingFallback: boolean;
}

function isEvalApiUnavailable(err: unknown): boolean {
  return (
    err instanceof ApiClientError &&
    err.status === 404 &&
    (err.message.includes("/api/v1/eval") || err.code === "internal_error")
  );
}

async function listEvalSuites(signal: QuerySignal): Promise<EvalSuitesQueryData> {
  try {
    const res = await evalApi.listSuites(signal);
    return {
      suites: res.suites.map(toSuiteSummary),
      usingFallback: false,
    };
  } catch (err) {
    if (isEvalApiUnavailable(err)) {
      return {
        suites: fallbackEvalSuites,
        usingFallback: true,
      };
    }
    throw err;
  }
}

async function getEvalRunDetail(
  runId: string,
  usingFallback: boolean,
  signal: QuerySignal,
): Promise<EvalRunDetailView | null> {
  if (usingFallback) {
    return fallbackRunDetails[runId] ?? null;
  }

  return toRunDetail(await evalApi.getRun(runId, signal));
}

async function getEvalRunDiff(
  runId: string,
  previousRunId: string,
  usingFallback: boolean,
  signal: QuerySignal,
): Promise<VerdictFlip[]> {
  if (usingFallback) {
    return fallbackVerdictFlips[runId] ?? [];
  }

  const res = await evalApi.diffRun(runId, previousRunId, signal);
  return res.flips;
}

export function useEvalSuitesQuery(authScope: string) {
  return useQuery({
    queryKey: evalQueryKeys.suites(authScope),
    queryFn: ({ signal }) => listEvalSuites(signal),
  });
}

export function useEvalRunDetailQuery(
  authScope: string,
  runId: string | null,
  usingFallback: boolean,
) {
  const source = usingFallback ? "fallback" : "api";

  return useQuery({
    queryKey: runId
      ? evalQueryKeys.runDetail(authScope, source, runId)
      : ["evals", authScope, "runs", source, "pending"],
    queryFn: ({ signal }) => getEvalRunDetail(runId!, usingFallback, signal),
    enabled: Boolean(runId),
  });
}

export function useEvalRunDiffQuery(
  authScope: string,
  runDetail: EvalRunDetailView | null | undefined,
  usingFallback: boolean,
) {
  const source = usingFallback ? "fallback" : "api";
  const runId = runDetail?.runId ?? "pending";
  const previousRunId = runDetail?.previousRunId ?? "pending";

  return useQuery({
    queryKey: evalQueryKeys.runDiff(authScope, source, runId, previousRunId),
    queryFn: ({ signal }) =>
      getEvalRunDiff(runDetail!.runId, runDetail!.previousRunId!, usingFallback, signal),
    enabled: Boolean(runDetail?.previousRunId),
  });
}
