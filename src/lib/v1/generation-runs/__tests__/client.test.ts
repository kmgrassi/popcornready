import assert from "node:assert/strict";
import test from "node:test";

import {
  GenerationRunClient,
  GenerationRunRequestError,
} from "../client";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function makeFetch(
  responder: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: RecordedCall = { url: String(input), init };
    calls.push(call);
    return await responder(call);
  };
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("listRuns issues a GET and returns the runs payload", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    jsonResponse(200, { runs: [{ runId: "r1", projectId: "p1" }] }),
  );
  const client = new GenerationRunClient({ fetchImpl });
  const runs = await client.listRuns("p1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "r1");
  assert.equal(calls[0].url, "/api/v1/projects/p1/generation-runs");
  assert.equal(calls[0].init?.method, "GET");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("Cache-Control"), "no-store");
});

test("getRun issues a GET against the run-specific URL", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    jsonResponse(200, { run: { runId: "r1" }, stages: [], stageItems: [] }),
  );
  const client = new GenerationRunClient({ fetchImpl });
  const detail = await client.getRun("p1", "r1");
  assert.equal(detail.run.runId, "r1");
  assert.equal(calls[0].url, "/api/v1/projects/p1/generation-runs/r1");
  assert.equal(calls[0].init?.method, "GET");
});

test("cancelRun POSTs to the cancel sub-resource with an empty body", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    jsonResponse(200, { run: { runId: "r1", status: "canceled" }, stages: [], stageItems: [] }),
  );
  const client = new GenerationRunClient({ fetchImpl });
  await client.cancelRun("p1", "r1");
  assert.equal(calls[0].url, "/api/v1/projects/p1/generation-runs/r1/cancel");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, "{}");
});

test("retryRun forwards stageId/itemId scope when provided", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    jsonResponse(200, { run: { runId: "r1" }, stages: [], stageItems: [] }),
  );
  const client = new GenerationRunClient({ fetchImpl });
  await client.retryRun("p1", "r1", { stageId: "s2", itemId: "i3" });
  assert.equal(calls[0].url, "/api/v1/projects/p1/generation-runs/r1/retry");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, JSON.stringify({ stageId: "s2", itemId: "i3" }));
});

test("retryRun sends an empty object when no scope is provided", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    jsonResponse(200, { run: { runId: "r1" }, stages: [], stageItems: [] }),
  );
  const client = new GenerationRunClient({ fetchImpl });
  await client.retryRun("p1", "r1");
  assert.equal(calls[0].init?.body, "{}");
});

test("encodes projectId and runId path segments", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    jsonResponse(200, { run: { runId: "r/1" }, stages: [], stageItems: [] }),
  );
  const client = new GenerationRunClient({ fetchImpl });
  await client.getRun("p?1", "r/1");
  assert.equal(calls[0].url, "/api/v1/projects/p%3F1/generation-runs/r%2F1");
});

test("throws GenerationRunRequestError with envelope details on a non-2xx response", async () => {
  const { fetchImpl } = makeFetch(() =>
    jsonResponse(409, {
      error: {
        code: "job_not_cancelable",
        message: "Run already finished",
        details: { code: "job_not_cancelable", message: "Run already finished", retryable: false },
      },
    }),
  );
  const client = new GenerationRunClient({ fetchImpl });
  await assert.rejects(
    () => client.cancelRun("p1", "r1"),
    (err: unknown) => {
      assert.ok(err instanceof GenerationRunRequestError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "job_not_cancelable");
      assert.equal(err.message, "Run already finished");
      assert.equal(err.summary?.retryable, false);
      return true;
    },
  );
});

test("falls back to a status-derived code when the body is not JSON", async () => {
  const { fetchImpl } = makeFetch(
    () =>
      new Response("internal error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
  );
  const client = new GenerationRunClient({ fetchImpl });
  await assert.rejects(
    () => client.listRuns("p1"),
    (err: unknown) => {
      assert.ok(err instanceof GenerationRunRequestError);
      assert.equal(err.status, 500);
      assert.equal(err.code, "http_500");
      return true;
    },
  );
});

test("baseUrl is prefixed to the request path", async () => {
  const { fetchImpl, calls } = makeFetch(() =>
    jsonResponse(200, { runs: [] }),
  );
  const client = new GenerationRunClient({
    fetchImpl,
    baseUrl: "https://api.example.com",
  });
  await client.listRuns("p1");
  assert.equal(
    calls[0].url,
    "https://api.example.com/api/v1/projects/p1/generation-runs",
  );
});
