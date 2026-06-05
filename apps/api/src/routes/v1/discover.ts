import { Router, type RequestHandler } from "express";
import { ApiError } from "@/core/errors";
import {
  parseDiscoverAssetsQuery,
  parseDiscoverSearchQuery,
  parsePagination,
} from "@/lib/api/v1/schemas";
import {
  listPublicAssets,
  listPublicProjects,
  searchPublicContent,
} from "@/lib/api/v1/store";

export const discoverRouter = Router();

function publicRoute(
  fn: (req: Parameters<RequestHandler>[0]) => Promise<{ status: number; body: unknown }>
): RequestHandler {
  return async (req, res) => {
    try {
      const result = await fn(req);
      res.status(result.status).json(result.body);
    } catch (err) {
      const apiError =
        err instanceof ApiError
          ? err
          : new ApiError(
              "internal_error",
              err instanceof Error ? err.message : "Internal error."
            );
      res.status(apiError.status).json(apiError.envelope(req.requestId));
    }
  };
}

function searchParamsFor(req: Parameters<RequestHandler>[0]): URLSearchParams {
  return new URL(req.originalUrl, "http://localhost").searchParams;
}

discoverRouter.get(
  "/discover/projects",
  publicRoute(async (req) => {
    const { limit, cursor } = parsePagination(searchParamsFor(req));
    const { items, nextCursor } = await listPublicProjects(limit, cursor);
    return {
      status: 200,
      body: { projects: items, pagination: { limit, nextCursor } },
    };
  })
);

discoverRouter.get(
  "/discover/assets",
  publicRoute(async (req) => {
    const { limit, cursor, kind } = parseDiscoverAssetsQuery(searchParamsFor(req));
    const { items, nextCursor } = await listPublicAssets(limit, cursor, kind);
    return {
      status: 200,
      body: { assets: items, pagination: { limit, nextCursor } },
    };
  })
);

discoverRouter.get(
  "/discover/search",
  publicRoute(async (req) => {
    const { q, limit, cursor, kind } = parseDiscoverSearchQuery(searchParamsFor(req));
    const { items, nextCursor } = await searchPublicContent(q, limit, cursor, kind);
    return {
      status: 200,
      body: { results: items, pagination: { limit, nextCursor } },
    };
  })
);
