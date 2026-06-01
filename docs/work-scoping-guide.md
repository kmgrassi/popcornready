# Work Scoping Guide

Use this guide when scoping implementation work for an agent or human reviewer. The output should explain the shape of the work without becoming a file-by-file implementation plan.

## Summary of what needs to be built

Describe the user-facing capability, operational behavior, or developer workflow that needs to exist when the work is complete. Keep this focused on observable outcomes and important constraints.

Call out the systems involved and the intended ownership boundaries. Include enough context for a reviewer to understand why the work belongs in this repo and where it interacts with other repos or services.

## Shared/foundational work to land first

Identify contracts, schemas, protocol changes, shared components, shared services, or foundational refactors that feature-specific work depends on.

Prefer landing these pieces before feature implementation when they clarify boundaries, reduce duplication, or make later PRs independently reviewable. Avoid compatibility layers unless they are needed for a real rollout constraint.

## Numbered PR breakdown

Split the work into small, reviewable PRs that can be merged independently. Each PR should have one primary purpose, a clear review surface, and a concrete verification path.

Keep broad refactors separate from feature behavior when possible. Optimize for locality of change and long-term maintainability, not for avoiding every possible merge conflict.

For each PR, include:

1. A short title.
2. The behavior or contract it introduces.
3. The main systems it touches.
4. Any dependencies on earlier PRs.
5. How it should be verified.

## Follow-up work

List useful work that should not block the initial implementation. This can include polish, observability, cleanup after rollout, documentation expansion, or future capabilities.

Be explicit about why each item is follow-up rather than part of the first pass.
