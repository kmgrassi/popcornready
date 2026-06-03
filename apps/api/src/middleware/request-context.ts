import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

// Assigns a request id and echoes it on the response, matching the prior
// X-Request-Id contract emitted by the Next route handlers.
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const requestId = `req_${randomUUID().replace(/-/g, "")}`;
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}
