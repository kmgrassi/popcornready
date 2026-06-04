import express, { type Express, type Request } from "express";
import cors from "cors";
import { requestContext } from "./middleware/request-context.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { mountV1 } from "./routes/v1/mount.js";

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

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
