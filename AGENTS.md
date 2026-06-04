# Popcorn Ready — agent guide

Start with `CLAUDE.md` for product direction and repository conventions. This
file calls out conventions that matter for parallel agent work.

## Merge-Conflict Hygiene

- Prefer modular files with clear ownership over broad aggregation files.
- Avoid new `index.ts` files for route or feature registration unless the
  surrounding code already requires that shape.
- Use explicit file names that describe the boundary they own, such as
  `mount.ts`, `public-routes.ts`, `protected-routes.ts`, `routes.ts`, or a
  feature name.
- For `apps/api` Express routes, keep route-group logic in the route group file
  and update only the smallest mount file needed for that group's visibility or
  auth boundary.
- When planning parallel work, split tasks so each PR mostly edits distinct
  route, page, component, or package files.
