# CSS Migration Plan (Conflict-Safe PR Sequence)

## Summary

`src/app/globals.css` is currently a single shared stylesheet with many route- and
component-specific blocks (`lp-*`, `admin-*`, `progress-*`, editor primitives, etc.),
which is creating merge hotspots. The rollout below moves styles to CSS Modules in
coarse, independently mergeable PRs.

## Ground Rules

- Do not edit `src/app/globals.css` except in the final cleanup PR.
- Keep the global file to base variables, resets, and true shared tokens only.
- Use only class names generated from CSS Modules in migrated files (`styles.foo`).
- Preserve existing markup/behavior. No functional UX changes unless explicitly called out.
- Use one PR as a cleanup to remove migrated selectors from `globals.css`.

## PR1 — Styling foundation + migration scaffolding

### Goal

Create the project-level pattern so future PRs are predictable.

### Files

- `src/app/globals.css`
- `src/styles/tokens.css` *(new)*
- `src/styles/base.css` *(new)*
- `src/styles/utilities.css` *(new)*

### Scope

- Extract CSS variables (colors, spacing scale, radii, typography scale, z-index)
  from the current global file into `src/styles/tokens.css`.
- Move global reset/base rules (`*`, `html, body`, base links/forms, typography
  defaults) into `src/styles/base.css`.
- Keep only utility classes that truly belong global (`.muted`, `.ready`, `.error`,
  maybe shared button/fieldset utilities) and media-query-safe defaults in
  `globals.css`.
- Add comments documenting “do not add page/component rules in globals”.

### Merge safety

- This PR is foundational and should be merged first.
- It touches only new/infra style files and a small curated section in
  `globals.css`.

## PR2 — Landing page + prompt composer

### Goal

Migrate `/` styles into local modules with no behavior changes.

### Files

- `src/app/page.tsx`
- `src/components/PromptComposer.tsx`
- `src/app/page.module.css` *(new)*
- `src/components/PromptComposer.module.css` *(new)*

### Scope

- Replace all `className="lp-*"` usage with `styles.lp*` (module classes).
- Migrate inline styles in landing route into `page.module.css`/`PromptComposer.module.css`.
- Keep existing global class names removed from markup in these files only.

### Merge safety

- No changes to editor/admin/progress files.
- No changes to final cleanup of global selectors.

## PR3 — Admin page styles

### Goal

Move all `/admin`-specific class selectors to scoped styles.

### Files

- `src/app/admin/page.tsx`
- `src/app/admin/page.module.css` *(new)*

### Scope

- Migrate all `admin-*` classes and local inline styles.
- Keep admin-only layout selectors out of global scope.

### Merge safety

- Isolated file set.
- No edits to shared editor/progress files.

## PR4 — Progress views and progress components

### Goal

Scope all progress UI into route/component modules.

### Files

- `src/app/projects/[projectId]/runs/[runId]/page.tsx`
- `src/components/progress/ProgressView.tsx`
- `src/components/progress/StatusBanner.tsx`
- `src/components/progress/StageRail.tsx`
- `src/components/progress/TerminalState.tsx`
- `src/components/progress/progress.module.css` *(new)*
- `src/components/progress/ProgressView.module.css` *(new)*
- `src/app/projects/[projectId]/runs/[runId]/page.module.css` *(new)*

### Scope

- Move `progress-*`, `stage-*`, `terminal-*`, `status-banner-*`, and related inline
  styles from global.
- Keep semantics and conditional status classes intact.

### Merge safety

- Independent from landing/admin.
- Touches only run/preview + progress component files.

## PR5 — Editor surface migration

### Goal

Move the editor page and nested editor components to local modules.

### Files

- `src/components/Editor.tsx`
- `src/components/editor/SidebarPanel.tsx`
- `src/components/editor/CharacterPanel.tsx`
- `src/components/editor/LibraryPanel.tsx`
- `src/components/editor/AssetGenerationPanel.tsx`
- `src/components/editor/BriefPanel.tsx`
- `src/components/editor/PreviewPanel.tsx`
- `src/components/Preview.tsx`
- `src/components/editor/progress/RetryControl.tsx`
- `src/components/editor/progress/CancelControl.tsx`
- `src/components/editor/Editor.module.css` *(new)*
- `src/components/editor/...` *(corresponding module files per component)*

### Scope

- Migrate core editor classes (`app`, `col`, `row`, `card`, `segment`, `pill`,
  `video-*`, `review-grid`, `clip`, `chat`, etc.) plus inline style objects to
  module classes.
- Replace generic utility class usage with scoped equivalents.

### Merge safety

- Limited to editor subtree and preview primitives only.
- No overlap with landing/admin/progress route files.

## PR6 — Final global cleanup sweep

### Goal

Remove duplicated styles from `src/app/globals.css` and make it a true global layer.

### Files

- `src/app/globals.css`

### Scope

- Remove migrated selectors for sections and components now moved to modules.
- Keep only:
  - CSS variable fallbacks/imports
  - global resets/box-sizing/font/body defaults
  - truly app-wide utility helpers needed across routes
  - any remaining global third-party override needs

### Merge safety

- This is the final PR.
- All previous PRs should be merged/rebased before this sweep.

## Suggested acceptance criteria per PR

- `npm run build` and `npm run typecheck` pass.
- Existing visual snapshots/targeted pages look unchanged.
- No inline class migrations should alter logic or dynamic status text.
- No PR edits beyond its file scope.

## Optional rollout order

`PR1 -> PR2 -> PR3 -> PR4 -> PR5 -> PR6`.
