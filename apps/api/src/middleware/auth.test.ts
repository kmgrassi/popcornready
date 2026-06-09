import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { authMiddleware } from "./auth.js";

function requestWithAuthorization(value?: string): Request {
  return {
    requestId: "req_test",
    method: "GET",
    path: "/api/v1/protected",
    get(name: string) {
      return name.toLowerCase() === "authorization" ? value : undefined;
    },
  } as Request;
}

interface RecordedResponse {
  statusCode?: number;
  body?: unknown;
  status(code: number): RecordedResponse;
  json(body: unknown): RecordedResponse;
}

function responseRecorder(): RecordedResponse {
  const res: RecordedResponse = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

async function runAuth(value?: string) {
  const previousMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "hybrid";

  const res = responseRecorder();
  let nextCalls = 0;
  const next: NextFunction = () => {
    nextCalls += 1;
  };

  try {
    await authMiddleware(requestWithAuthorization(value), res as Response, next);
  } finally {
    if (previousMode == null) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = previousMode;
    }
  }

  return { res, nextCalls };
}

test("hybrid auth falls back only when Authorization is absent", async () => {
  const { res, nextCalls } = await runAuth();

  assert.equal(nextCalls, 1);
  assert.equal(res.statusCode, undefined);
});

test("hybrid auth rejects empty bearer headers", async () => {
  const { res, nextCalls } = await runAuth("Bearer ");

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, {
    error: {
      code: "unauthorized",
      message: "Invalid or expired session.",
      requestId: "req_test",
    },
  });
});

test("hybrid auth rejects non-bearer Authorization headers", async () => {
  const { res, nextCalls } = await runAuth("Basic abc123");

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, {
    error: {
      code: "unauthorized",
      message: "Invalid or expired session.",
      requestId: "req_test",
    },
  });
});
