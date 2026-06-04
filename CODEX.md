# Popcorn Ready — Codex guide

Use this alongside `CLAUDE.md`; that file contains the broader agent guide and
product architecture direction.

## Directory and Module Shape

- Build directories to minimize shared edit hotspots while preserving cohesive
  modules. Prefer feature-level files and narrow registration files over broad
  catch-all aggregators.
- Avoid adding new `index.ts` files as cross-module merge points. Use explicit
  names such as `mount.ts`, `routes.ts`, `public-routes.ts`,
  `protected-routes.ts`, `client.ts`, or a feature name.
- For Express API work, route modules should export their own router, and mount
  files should preserve important boundaries such as public-before-auth and
  protected-after-auth. Add new route groups to the smallest relevant mount file
  instead of centralizing unrelated route work in one index file.
- When parallel PRs are expected, split by ownership: one route group, page, or
  feature per file where practical. Keep shared files small and mechanical so
  conflicts are rare and easy to resolve.

## Validation

- For API route and server changes, run `pnpm --filter @popcorn/api typecheck`
  when dependencies are installed.
