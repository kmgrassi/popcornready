import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../core/errors.js";

// 404 for unmatched routes, in the shared error envelope.
export function notFound(req: Request, res: Response) {
  const err = new ApiError("not_found", `No route for ${req.method} ${req.path}.`);
  res.status(err.status).json(err.envelope(req.requestId));
}

// Terminal error handler: maps ApiError (and unknown throws) to the envelope
// shape every client already expects.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const apiError =
    err instanceof ApiError
      ? err
      : new ApiError("internal_error", err instanceof Error ? err.message : "Internal error.");
  if (!(err instanceof ApiError)) {
    // eslint-disable-next-line no-console
    console.error(`[api] unhandled error on ${req.method} ${req.path}:`, err);
  }
  res.status(apiError.status).json(apiError.envelope(req.requestId));
}
