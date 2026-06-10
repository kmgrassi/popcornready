# Guided dashboard PR 7 — findability audit worksheet

PR 7 is the final QA pass for
[guided-dashboard-prs.md](./guided-dashboard-prs.md). It should run only after
PRs 1-6 have landed, because the audit depends on the Home launchpad,
server-backed drafts, final navigation, unified Library, Settings page, and
command palette.

## Preflight

- `/dashboard` renders the state-aware Home launchpad, not a placeholder.
- `/studio` can resume server-backed drafts and active runs.
- Sidebar primary navigation is Create, Library, Settings.
- `/library` owns Projects, Runs, Assets, Outputs, and Evals.
- `/settings` is a real page with account, workspace, theme, and quiet links to
  Uploads, Templates, and Brand Kit.
- Command palette opens globally and has a registry mount file.

If any preflight item fails, PR 7 should stay blocked and the missing owning PR
should be finished first.

## Ladder audit

| Surface | L0 check | L1/L2 config check | L3+ findability check | Status |
|---|---|---|---|---|
| Home launchpad | Shows exactly one primary next action by urgency order. | Secondary chips do not compete with the hero action. | Home, New video, Continue draft, Watch run, Review cut, and waiting-gate actions are palette-searchable. | Pending prerequisites |
| Studio brief | The step CTA is the only primary action. | Goal, style, audience, duration, aspect ratio, and advanced creative direction are within the step. | Aspect ratio and advanced creative direction commands deep-link to this step and open the disclosure. | Pending prerequisites |
| Studio footage/story/review/export | Each step has one primary forward action. | Source footage, story direction, review gates, captions, export format, and related optional controls are within two interactions from the step. | All L2 options have palette entries by name. | Pending prerequisites |
| Library | Browsing does not compete with creation as an L0 action. | Filters, pagination, and tab state stay local to Library. | Projects, Runs, Assets, Outputs, Evals, and project Storyboard entries are palette-searchable. | Pending prerequisites |
| Settings | Settings uses grouped controls, not a creation CTA. | Theme, account, workspace, and workspace defaults are on the page; stubs are quiet links. | Settings, Uploads, Templates, Brand Kit, and sign-out are palette-searchable. | Pending prerequisites |
| Storyboard/Evals/stub routes | No standalone route introduces a second global creation CTA. | Project-scoped or workspace-scoped controls stay on their owning surface. | Demoted routes remain routable and palette-searchable. | Pending prerequisites |

## Copy and polish pass

- Align labels and helper copy with `apps/web/src/components/studio/copy.ts`.
- Prefer action-oriented labels: "Continue draft", "Review cut", "Watch run".
- Avoid placeholder language on shipped surfaces.
- Keep global navigation quiet: no duplicate Studio entry, no topnav, no loud
  links to demoted stubs.
- Add missing palette commands in the owning feature `commands.ts`; wire them
  through `components/palette/registry.ts` without introducing a broad index.

## Done when

- Every screen has at most one L0 action.
- Every config option is reachable within two interactions from where it is
  relevant.
- Every L3+ route, action, and option can be found by name in the palette.
- Old routes still work through redirects or quiet routed stubs.
- The acceptance table in `guided-dashboard-prs.md` passes end to end.
