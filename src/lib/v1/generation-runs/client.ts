// Browser client for the generation-run polling, retry, and cancel endpoints
// defined in docs/scopes/generation-progress-ui.md.
//
// PR #8 owns the cancel/retry/recovery flows that call these helpers. The
// underlying HTTP endpoints are PR #4's deliverable and do not exist yet, so
// this client is a thin wrapper that returns a typed error envelope when the
// route is missing instead of throwing an opaque fetch error.

import { GenerationErrorSummary, GenerationRun } from "../types";
import { GenerationRunDetail } from "./status";

export interface GenerationRunClientOptions {
  // Defaults to the global `fetch`. Injected in tests.
  fetchImpl?: typeof fetch;
  // Defaults to "". Set to point at a different origin (eg. server-side calls
  // during recovery).
  baseUrl?: string;
}

export interface ListGenerationRunsResponse {
  runs: GenerationRun[];
}

export interface RetryGenerationRunOptions {
  // Optional stage or stage-item scope. The open decision in the scope doc
  // leaves the granularity to V1 — surface both so callers can pick.
  stageId?: string;
  itemId?: string;
}

export class GenerationRunRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly summary?: GenerationErrorSummary;

  constructor(status: number, code: string, message: string, summary?: GenerationErrorSummary) {
    super(message);
    this.name = "GenerationRunRequestError";
    this.status = status;
    this.code = code;
    this.summary = summary;
  }
}

export class GenerationRunClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: GenerationRunClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "";
  }

  async listRuns(projectId: string, signal?: AbortSignal): Promise<GenerationRun[]> {
    const response = await this.request(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs`,
      undefined,
      signal,
    );
    const body = (await response.json()) as ListGenerationRunsResponse;
    return body.runs ?? [];
  }

  async getRun(
    projectId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<GenerationRunDetail> {
    const response = await this.request(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}`,
      undefined,
      signal,
    );
    return (await response.json()) as GenerationRunDetail;
  }

  async cancelRun(
    projectId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<GenerationRunDetail> {
    const response = await this.request(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}/cancel`,
      {},
      signal,
    );
    return (await response.json()) as GenerationRunDetail;
  }

  async retryRun(
    projectId: string,
    runId: string,
    options: RetryGenerationRunOptions = {},
    signal?: AbortSignal,
  ): Promise<GenerationRunDetail> {
    const body: Record<string, string> = {};
    if (options.stageId) body.stageId = options.stageId;
    if (options.itemId) body.itemId = options.itemId;
    const response = await this.request(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/generation-runs/${encodeURIComponent(runId)}/retry`,
      body,
      signal,
    );
    return (await response.json()) as GenerationRunDetail;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);

    if (!response.ok) {
      throw await toRequestError(response);
    }

    return response;
  }
}

async function toRequestError(response: Response): Promise<GenerationRunRequestError> {
  let code = `http_${response.status}`;
  let message = response.statusText || "Generation-run request failed";
  let summary: GenerationErrorSummary | undefined;

  try {
    const payload = (await response.clone().json()) as {
      error?: { code?: string; message?: string; details?: GenerationErrorSummary };
    };
    if (payload?.error?.code) code = payload.error.code;
    if (payload?.error?.message) message = payload.error.message;
    if (payload?.error?.details) summary = payload.error.details;
  } catch {
    // Body wasn't JSON. Fall back to status-derived code/message.
  }

  return new GenerationRunRequestError(response.status, code, message, summary);
}
