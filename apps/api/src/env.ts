import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

// The monorepo split replaced Next's automatic env loading with a bare
// `import "dotenv/config"`, which only loaded `./.env` from the process cwd —
// and every start path runs from `apps/api`, where no `.env` exists — so no
// local env (Supabase, provider keys) was ever loaded. This restores it,
// cwd-independent: the repo root is resolved from this module's location, so
// every start path (`pnpm dev`, `pnpm dev:api`, `pnpm --filter @popcorn/api
// start`) behaves the same.
//
// Precedence (highest first): real process.env > .env.local > .env.<NODE_ENV>
// > .env. `.env.local` is the authoritative local-secrets file and wins over
// the committed/base files — it is the only file with the coherent server
// Supabase pair (URL + service-role key). dotenv does not override keys
// already present, so highest-priority files are loaded first and the
// platform-injected env (e.g. Railway) always wins. Missing files are skipped,
// so in production (injected env only) this is a no-op.
const here = dirname(fileURLToPath(import.meta.url)); // apps/api/src
const repoRoot = resolve(here, "../../..");
const nodeEnv = process.env.NODE_ENV || "development";

const candidates = [
  ".env.local",
  `.env.${nodeEnv}.local`,
  `.env.${nodeEnv}`,
  ".env",
];

for (const file of candidates) {
  const path = resolve(repoRoot, file);
  if (existsSync(path)) {
    config({ path });
  }
}
