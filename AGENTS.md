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

## Styling (CSS Modules + global tokens)

`apps/web/src/styles/globals.css` grew into a multi-thousand-line monolith that
every UI PR touches — the single biggest styling merge hotspot, and a large
blast radius (one unbalanced brace there once dropped all styles below it). New
styling work must **not** add to it. The direction (see
`docs/scopes/css-module-migration-pr-plan.md`) is **CSS Modules co-located with
components, on top of a small global token layer.** Vite supports `*.module.css`
natively — no CSS-in-JS runtime or new dependency.

The **only** global stylesheets (imported once in `apps/web/src/main.tsx`):

- `styles/tokens.css` — design tokens as CSS variables (colors, spacing, radii,
  type scale, z-index) **and** the theme variants (`:root`,
  `:root[data-theme="…"]`). This is the single source of truth for theming.
- `styles/base.css` — resets, `box-sizing`, `html/body`, base element defaults.
- `styles/utilities.css` — a *tiny* set of truly app-wide helpers (e.g. `.muted`).

Everything else is **component/route-scoped**: co-locate a `Foo.module.css` next
to `Foo.tsx`, import it as `import styles from "./Foo.module.css"`, and reference
`className={styles.shell}`. Module class names are local — no global
`lp-*`/`dashboard-*`-style prefixes, no cross-file collisions, no growth in
`globals.css`.

**Theming is CSS-variable based, not per-component JS.** Components never
hardcode colors — always consume a token (`color: var(--text)`,
`background: var(--accent)`). The theme switcher only flips
`document.documentElement.dataset.theme`; every module restyles automatically.
Need a new color? Add a `--token` to `tokens.css` (and each `[data-theme]`
variant), then use `var(--token)` — never inline a hex.

Rules for agents:

- Do **not** add component or page rules to `globals.css`. Treat it as read-only
  legacy that is being retired.
- New component/route → new co-located `*.module.css`. Use `var(--token)` for
  every color/spacing value where a token exists; no magic hex/px.
- Don't introduce a second theming mechanism (CSS-in-JS, inline style themes,
  Tailwind). The `data-theme` + CSS-variable system in `tokens.css` is the one
  theme source.
- If you must edit an element still on a legacy global class, prefer migrating
  that component's styles into a module in the same PR — but keep the PR scoped
  to that component; don't bulk-rewrite `globals.css`.

```tsx
// Card.tsx
import styles from "./Card.module.css";
export function Card({ children }: { children: React.ReactNode }) {
  return <div className={styles.card}>{children}</div>;
}
```

```css
/* Card.module.css */
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}
```
