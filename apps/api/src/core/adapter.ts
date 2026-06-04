import type { Request, RequestHandler, Response } from "express";
import { ApiError } from "./errors.js";
import {
  handleMutation,
  handleRead,
  type ApiRequestView,
  type ApiResult,
  type HandlerCtx,
} from "@/lib/api/v1/handler";

type RouteParams = Record<string, string | undefined>;
type CoreRouteFn = (ctx: HandlerCtx, params: RouteParams) => Promise<ApiResult>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

function searchParamsFor(req: Request): URLSearchParams {
  return new URL(req.originalUrl, "http://localhost").searchParams;
}

function requestView(req: Request): ApiRequestView {
  return {
    method: req.method,
    pathname: new URL(req.originalUrl, "http://localhost").pathname,
    searchParams: searchParamsFor(req),
    header(name: string) {
      return req.get(name) ?? null;
    },
    async rawBody() {
      if (req.rawBody !== undefined) return req.rawBody;
      if (req.body === undefined) return "";
      return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    },
  };
}

function sendResult(res: Response, result: ApiResult) {
  if (result.headers) {
    for (const [name, value] of Object.entries(result.headers)) {
      res.setHeader(name, value);
    }
  }
  res.status(result.status).json(result.body);
}

function sendError(req: Request, res: Response, err: unknown) {
  const apiError =
    err instanceof ApiError
      ? err
      : new ApiError("internal_error", err instanceof Error ? err.message : "Internal error.");
  res.status(apiError.status).json(apiError.envelope(req.requestId));
}

export function route(fn: CoreRouteFn): RequestHandler {
  return async (req, res) => {
    try {
      sendResult(
        res,
        await handleRead(requestView(req), (ctx) => fn(ctx, req.params), req.requestId)
      );
    } catch (err) {
      sendError(req, res, err);
    }
  };
}

export function mutation(fn: CoreRouteFn): RequestHandler {
  return async (req, res) => {
    try {
      sendResult(
        res,
        await handleMutation(requestView(req), (ctx) => fn(ctx, req.params), req.requestId)
      );
    } catch (err) {
      sendError(req, res, err);
    }
  };
}
