import path from "node:path";
import express, { type Express, type Request } from "express";
import cors from "cors";
import { requestContext } from "./middleware/request-context.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { mountV1 } from "./routes/v1/mount.js";
import { readStorageConfig } from "./lib/storage/config.js";

// CORS allowlist comes from the web origin(s). Comma-separated WEB_ORIGIN env,
// or allow all in local development.
function corsOptions(): cors.CorsOptions {
  const raw = (process.env.WEB_ORIGIN || "").trim();
  if (!raw) return { origin: true, credentials: true };
  const origins = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return { origin: origins, credentials: true };
}

export function createServer(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors(corsOptions()));
  app.use(requestContext);
  app.use(
    express.json({
      limit: "25mb",
      verify(req, _res, buf) {
        (req as Request).rawBody = buf.toString("utf8");
      },
    })
  );

  mountV1(app);
  mountLocalMedia(app);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

// Local storage backend only: serve the on-disk object store over HTTP so the
// media URLs resolveAssetUrl() returns (absolute against localUrlBase, see
// lib/storage/asset-urls.ts) are fetchable by the SPA. S3 mode serves nothing
// here — public objects get stable bucket/CDN URLs and private ones presigned
// URLs. Dev-only by construction; like the pre-split monolith's .local/media
// serving, local media reads are not authenticated.
function mountLocalMedia(app: Express) {
  const config = readStorageConfig();
  if (config.backend !== "local") return;

  const staticOpts = { fallthrough: true, index: false } as const;
  // New-layout objects live under <localMediaDir>/<bucket>/<key> and are
  // addressed as /<key>; legacy rows keyed media/uploads|generated/... are
  // addressed as /uploads|generated/... directly under <localMediaDir>.
  app.use(express.static(path.join(config.localMediaDir, config.publicBucket), staticOpts));
  app.use(express.static(path.join(config.localMediaDir, config.privateBucket), staticOpts));
  app.use(express.static(config.localMediaDir, staticOpts));
}
