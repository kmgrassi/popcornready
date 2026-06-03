import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../core/errors.js";

// 404 for unmatched routes, in the shared error envelope.
export function notFound(req: Request, res: Response) {
  const err = new ApiError("not_found", `No route for ${req.method} ${req.path}.`);
  res.status(err.status).json(err.envelope(req.requestId));
}

// body-parser (express.json) rejects malformed/oversized bodies BEFORE any route
// runs, so the adapter's own parse handling never sees them. Map those to the v1
// validation envelope — parity with the old handleMutation parseJsonBody, which
// returned `validation_failed` 400 for invalid JSON — instead of letting them
// fall through to a generic internal_error.
function bodyParserError(err: unknown): ApiError | null {
  if (typeof err !== "object" || err === null) return null;
  const type = (err as { type?: string }).type;
  if (type === "entity.parse.failed") {
    return new ApiError("validation_failed", "Request body must be valid JSON.");
  }
  if (type === "entity.too.large") {
    return new ApiError("validation_failed", "Request body is too large.");
  }
  return null;
}

// Terminal error handler: maps ApiError (and unknown throws) to the envelope
// shape every client already expects.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let apiError: ApiError;
  if (err instanceof ApiError) {
    apiError = err;
  } else {
    const mapped = bodyParserError(err);
    if (mapped) {
      apiError = mapped;
    } else {
      apiError = new ApiError("internal_error", err instanceof Error ? err.message : "Internal error.");
      // eslint-disable-next-line no-console
      console.error(`[api] unhandled error on ${req.method} ${req.path}:`, err);
    }
  }
  res.status(apiError.status).json(apiError.envelope(req.requestId));
}
