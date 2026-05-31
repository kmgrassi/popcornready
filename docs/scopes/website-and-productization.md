# Website And Productization Scope

## Objective

Give Popcorn Ready a public front door and a pathway from open-source project to hosted
product. The MVP proves the core loop; this scope adds the marketing surface
that explains the product, lets a visitor start a video from a single prompt,
presents hosted pricing, and points self-hosters to GitHub. It connects the
landing experience to the productization phases already defined in
[`../productionization-scope.md`](../productionization-scope.md).

## What Ships First (in this repo today)

- A marketing landing page at `/` that explains what Popcorn Ready is, how the loop
  works, what it does, hosted pricing, and a link to the GitHub repo for
  self-hosting.
- A **one-shot** prompt entry point on the landing page: the visitor describes a
  30-second video (optionally starting from one of four template chips), and
  Popcorn Ready generates the video with no uploads required.
- The existing editor moves to `/studio`, which reads `goal`, `length`, and
  `autostart` from the query string. With `autostart=1` it immediately runs the
  one-shot pipeline and shows the result.

The one-shot pipeline (`POST /api/oneshot`) plans beats from the prompt,
generates one visual per beat, assembles a timeline, and runs the critic — so a
visitor with no footage still gets a finished, editable cut.

By default it generates a real **video clip per beat** (OpenAI Sora when
`OPENAI_API_KEY` is set, Gemini Veo when `GEMINI_API_KEY` is set), so the
visitor sees an actual moving 30-second video — the differentiator vs. tools
that only return a prompt-to-clip stub. This is deliberately expensive, so it is
gated by an operator **kill switch**: `ONESHOT_VIDEO=off` falls back to fast,
cheap still-frame generation, intended to be flipped when traffic outpaces the
generation budget. When no video-capable key is present (and for local/demo use)
the pipeline degrades to image mode — real OpenAI images with a key, placeholder
frames without — so the flow always completes.

Clips are generated in parallel, so wall-clock latency is roughly the slowest
single clip rather than the sum; even so, video generation takes a couple of
minutes. Making this an async job with status polling (so the request doesn't
block) is the remaining Phase 3 hardening.

## Landing Page Content Model

- **Hero**: one-line value prop + the one-shot prompt form with template chips.
- **How it works**: the four-step loop — brief, plan, editable timeline,
  deterministic render — mirroring the README pipeline.
- **What it does**: bring-or-generate footage, character consistency,
  conversational revision, inspectable/safe rendering.
- **Pricing**: self-host (free) plus hosted tiers (see below).
- **Self-host CTA**: clone command + GitHub link.

## Hosted Pricing (indicative launch tiers)

Pricing is volume- and render-based because the cost drivers are model calls
(planning, critique, asset generation) and server-side rendering minutes. The
numbers below are starting proposals to validate, not final.

| Tier      | Price       | For                     | Key limits |
|-----------|-------------|-------------------------|------------|
| Self-host | Free        | Tinkerers, OSS users    | Bring your own model keys; unlimited local renders |
| Creator   | $19 / mo    | Solo short-form creators| ~30 finished videos/mo; 1080p; 1 workspace |
| Pro       | $49 / mo    | Heavy creators / freelancers | ~150 videos/mo; character consistency; 4K; agent API preview |
| Studio    | Custom      | Teams                   | Seats, workspaces, custom quotas, full agent API, SSO |

Pricing decisions to resolve before launch:

- Whether quotas are "finished videos," render minutes, or generation credits.
- How self-supplied model keys (BYO-key) interact with hosted quotas.
- Free hosted trial allowance vs. self-host-only free tier.
- Overage behavior: hard cap vs. metered overage.
- How per-beat video generation cost (the main COGS driver) maps to tier
  limits, and the policy for tripping the `ONESHOT_VIDEO` kill switch when
  traffic outruns the budget.

## Two-Track Productization

Popcorn Ready monetizes the same product two ways; both must stay in sync with the
durable principle that AI plans and patches structured timelines while Popcorn Ready
validates, versions, renders, and stores.

1. **Open source / self-host.** The repo is the free tier. A user clones it,
   supplies their own provider keys, and runs everything locally. This is the
   acquisition and trust channel; it must always be able to run end-to-end
   without the hosted backend (the local auth-bypass mode in the
   productionization scope).
2. **Hosted.** We run rendering, storage, model orchestration, and quotas so
   non-technical users never touch keys or infrastructure. This is where
   Supabase auth, workspaces, jobs, object storage, and billing live.

## Pathway From MVP To Hosted Product

This maps onto the phases in the productionization scope:

- **Phase 1 (Stabilize):** landing page + studio split (this scope), plus the
  app-shape and project-isolation work. Marketing site can ship before the
  backend split since it only needs the prompt-handoff.
- **Phase 2 (Structured context + agent API):** hosted accounts via Supabase
  auth, workspaces, project briefs, and the agent API that powers both the
  hosted UI and external automation. Pricing tiers gate quotas here.
- **Phase 3 (Durable production):** metered billing, object storage, background
  render workers, quotas/rate limits, and hardening the one-shot — moving the
  (already shipping) per-beat video generation onto async jobs with status
  polling, plus generated audio, so long renders never block the request.

## Out Of Scope For This Pass

- Billing integration, metering, and account provisioning (Phase 2/3).
- Async job/status polling for one-shot generation (Phase 3) — v1 runs
  synchronously within the request and relies on the `ONESHOT_VIDEO` kill switch
  for cost control.
- Auth on the marketing site; it is public and static apart from the form.
- Final pricing — the tiers here are launch proposals to validate with users.

## Definition Of Done (this pass)

- Visiting `/` shows the landing page with hero, template chips, how-it-works,
  features, pricing, and a working GitHub link.
- Entering a prompt (or picking a template) and submitting lands on `/studio`,
  which auto-runs the one-shot and shows the generated, editable cut.
- The studio also exposes the one-shot directly ("Create video from prompt")
  alongside the existing "Cut from my clips" flow.
- `npm run build` and `npm run typecheck` pass.
