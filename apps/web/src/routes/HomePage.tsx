import { Link } from "react-router-dom";
import { LogoMark } from "../components/LogoMark";
import { PromptComposer } from "../components/PromptComposer";

const GITHUB_URL = "https://github.com/kmgrassi/popcornready";

const STEPS = [
  {
    n: "1",
    title: "Write a brief",
    body: "Describe the video you want: your goal, length, style, and audience. One prompt is enough to start.",
  },
  {
    n: "2",
    title: "AI plans the beats",
    body: "Claude turns your intent into a structured plan: a hook, the beats that carry it, and the payoff.",
  },
  {
    n: "3",
    title: "Generate & assemble",
    body: "Popcorn Ready generates a visual for each beat, assembles an editable timeline, and a critic improves the cut.",
  },
  {
    n: "4",
    title: "Deterministic render",
    body: "Export a real MP4 via Remotion. The AI only edits structured data; it never touches raw video.",
  },
];

const FEATURES = [
  {
    title: "Bring or generate footage",
    body: "Upload your own clips, or generate missing shots with OpenAI, Gemini Veo, and ElevenLabs audio.",
  },
  {
    title: "Character consistency",
    body: "Lock identity, wardrobe, and style with reference packs so generated shots stay on-model.",
  },
  {
    title: "Revise by conversation",
    body: "Every message becomes validated timeline edits.",
  },
  {
    title: "Inspectable & safe",
    body: "Every cut traces back to source clips, prompts, and patches. Bad model output is clamped, not rendered.",
  },
];

// Ordered by Popcorn Ready's strength: what it's best at on the left, weakest on
// the right. Every HEATMAP_ROWS `scores` array is in this same column order.
const HEATMAP_COLUMNS = [
  "AI workflow",
  "Gen AI",
  "Timeline model",
  "Audio",
  "Captions",
  "Versioning",
  "VFX",
  "Manual edit",
];

const HEATMAP_LEVELS = ["Minimal", "Light", "Medium", "Strong"];

const HEATMAP_EXPLANATIONS: Record<string, string> = {
  "Manual edit":
    "Whether a user can directly cut, trim, rearrange, and stitch video without relying on AI.",
  "Timeline model":
    "Whether the product represents the edit as a structured timeline with inspectable segments and render decisions.",
  Audio:
    "Whether the product can create, clean up, arrange, or export useful audio alongside the video.",
  VFX: "Whether the product supports deeper visual compositing, masking, effects, and shot manipulation.",
  Captions:
    "Whether captions, transcripts, subtitles, or localization workflows are a central capability.",
  "Gen AI":
    "Whether the product can generate or transform media such as video, images, voice, or effects.",
  "AI workflow":
    "Whether AI drives the full workflow end to end, rather than appearing as isolated tools inside a manual editor.",
  Versioning:
    "Whether the product supports review, project history, collaboration, or version control.",
};

const POPCORN_READY_HEATMAP_EXPLANATIONS: Record<string, string> = {
  "Manual edit":
    "Popcorn Ready does not currently provide a manual timeline UI for hand-stitching or editing without AI.",
  "Timeline model":
    "Popcorn Ready produces and patches a structured timeline, so the output remains inspectable even though edits are AI-driven.",
  Audio:
    "Popcorn Ready can generate or overlay audio and render it with the finished video, but it is not a full audio-post workstation.",
  VFX: "Popcorn Ready focuses on generated shots and deterministic assembly, not deep manual compositing or effects work.",
  Captions:
    "Popcorn Ready supports burned-in caption text in rendered videos, but it is not yet a full transcript, subtitle, and localization suite.",
  "Gen AI":
    "Popcorn Ready is generation-first: it can create missing visual assets instead of requiring source footage.",
  "AI workflow":
    "This is the core differentiator: brief, plan, asset generation, audio, timeline, and export happen through one AI-driven loop.",
  Versioning:
    "Local exports and inspectable plans exist today; richer cloud review and version history would come later.",
};

const HEATMAP_ROWS = [
  {
    app: "Popcorn Ready",
    scores: [3, 3, 3, 2, 2, 2, 1, 0],
    note: "Fully AI-driven brief-to-plan-to-assets-to-timeline flow; not a manual stitching or hand-editing tool.",
    featured: true,
  },
  {
    app: "Premiere Pro",
    scores: [1, 2, 3, 2, 3, 2, 2, 3],
    note: "Broad professional craft stack with Adobe ecosystem depth.",
  },
  {
    app: "DaVinci Resolve",
    scores: [1, 1, 3, 3, 2, 3, 3, 3],
    note: "Deepest finishing, color, audio, VFX, and collaboration suite.",
  },
  {
    app: "CapCut",
    scores: [2, 3, 2, 1, 3, 2, 1, 2],
    note: "Fast social editing with strong creator AI.",
  },
  {
    app: "VEED",
    scores: [2, 3, 1, 1, 3, 2, 0, 1],
    note: "Web editing shell with captions, dubbing, and model brokerage.",
  },
  {
    app: "Descript",
    scores: [2, 2, 2, 2, 3, 2, 1, 2],
    note: "Transcript-native editing for explainers, podcasts, and repurposing.",
  },
  {
    app: "Runway",
    scores: [2, 3, 1, 0, 0, 1, 2, 1],
    note: "Generative studio for shot invention and manipulation.",
  },
  {
    app: "Frame.io",
    scores: [0, 0, 0, 0, 1, 3, 0, 0],
    note: "Review and versioning backbone rather than an editor.",
  },
];

const PRICING = [
  {
    name: "Self-host",
    price: "Free",
    cadence: "open source",
    blurb: "Run the whole studio yourself. Bring your own model keys.",
    features: [
      "Full studio + editor",
      "Bring your own API keys",
      "Unlimited local renders",
      "Community support",
    ],
    cta: { label: "Get it on GitHub", href: GITHUB_URL, external: true },
    featured: false,
  },
  {
    name: "Creator",
    price: "$19",
    cadence: "per month",
    blurb: "Hosted rendering for solo creators shipping short-form video.",
    features: [
      "~30 finished videos / mo",
      "Hosted rendering, no setup",
      "1080p watermark-free export",
      "1 workspace",
    ],
    cta: { label: "Start creating", href: "/studio", external: false },
    featured: true,
  },
  {
    name: "Pro",
    price: "$49",
    cadence: "per month",
    blurb: "More volume, character consistency, and early API access.",
    features: [
      "~150 finished videos / mo",
      "Character consistency packs",
      "Priority rendering + 4K export",
      "Agent API preview",
    ],
    cta: { label: "Go Pro", href: "/studio", external: false },
    featured: false,
  },
  {
    name: "Studio",
    price: "Custom",
    cadence: "for teams",
    blurb: "Seats, workspaces, quotas, and the full agent API for teams.",
    features: [
      "Multiple seats & workspaces",
      "Custom quotas & SLAs",
      "Full agent / automation API",
      "SSO & priority support",
    ],
    cta: { label: "Contact us", href: `${GITHUB_URL}/issues`, external: true },
    featured: false,
  },
];

function heatmapTooltip(app: string, column: string, score: number) {
  const explanation =
    app === "Popcorn Ready"
      ? POPCORN_READY_HEATMAP_EXPLANATIONS[column]
      : HEATMAP_EXPLANATIONS[column];
  return `${app}: ${column} is ${HEATMAP_LEVELS[score].toLowerCase()}. ${explanation}`;
}

function HeatLogoScale({ score }: { score: number }) {
  return (
    <span className={`lp-heat-scale count-${score}`} aria-hidden="true">
      {Array.from({ length: score }, (_, index) => (
        <LogoMark className="lp-heat-mark" key={index} />
      ))}
    </span>
  );
}

export function HomePage() {
  return (
    <div className="landing">
      <main>
        <section className="lp-hero">
          <span className="lp-eyebrow">AI-native video studio</span>
          <h1>
            Describe it. <span className="lp-accent">Popcorn Ready cuts it.</span>
          </h1>
          <p className="lp-lede">
            Describe the video you want and Popcorn Ready plans the beats,
            generates the visuals, and cuts a finished 30-second video. The AI
            plans and patches; rendering stays deterministic.
          </p>
          <PromptComposer />
        </section>

        <section id="how" className="lp-section">
          <h2 className="lp-section-title">How it works</h2>
          <p className="lp-section-sub">
            One loop: brief &rarr; plan &rarr; timeline &rarr; render.
          </p>
          <div className="lp-steps">
            {STEPS.map((step) => (
              <div className="lp-step" key={step.n}>
                <span className="lp-step-n">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-section">
          <h2 className="lp-section-title">What it does</h2>
          <div className="lp-grid">
            {FEATURES.map((feature) => (
              <div className="lp-card" key={feature.title}>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-section" aria-label="Competitive feature heatmap">
          <h2 className="lp-section-title">Where it fits</h2>
          <p className="lp-section-sub">
            Popcorn Ready sits between pro editing rigor and generative video
            tools. Its sharpest difference is the end-to-end AI workflow: brief,
            plan, assets, audio, timeline, and export in one loop.
          </p>
          <div className="lp-heatmap-wrap">
            <div className="lp-heatmap">
              <div className="lp-heatmap-head">
                <span>Tool</span>
                {HEATMAP_COLUMNS.map((column) => (
                  <span key={column}>{column}</span>
                ))}
                <span>Positioning</span>
              </div>
              {HEATMAP_ROWS.map((row) => (
                <div
                  className={`lp-heatmap-row${row.featured ? " featured" : ""}`}
                  key={row.app}
                >
                  <strong>{row.app}</strong>
                  {row.scores.map((score, index) => (
                    <button
                      type="button"
                      className={`lp-heat-cell level-${score}`}
                      key={`${row.app}-${HEATMAP_COLUMNS[index]}`}
                      aria-label={heatmapTooltip(
                        row.app,
                        HEATMAP_COLUMNS[index],
                        score
                      )}
                    >
                      <em>{HEATMAP_COLUMNS[index]}</em>
                      <HeatLogoScale score={score} />
                      <span className="lp-heat-tip">
                        {heatmapTooltip(row.app, HEATMAP_COLUMNS[index], score)}
                      </span>
                    </button>
                  ))}
                  <p>{row.note}</p>
                </div>
              ))}
            </div>
            <div className="lp-heatmap-legend" aria-hidden="true">
              <span>
                <span className="lp-heat-scale count-0" /> Minimal
              </span>
              <span>
                <span className="lp-heat-scale count-1">
                  <LogoMark className="lp-heat-mark" />
                </span>
                Light
              </span>
              <span>
                <span className="lp-heat-scale count-2">
                  <LogoMark className="lp-heat-mark" />
                  <LogoMark className="lp-heat-mark" />
                </span>
                Medium
              </span>
              <span>
                <span className="lp-heat-scale count-3">
                  <LogoMark className="lp-heat-mark" />
                  <LogoMark className="lp-heat-mark" />
                  <LogoMark className="lp-heat-mark" />
                </span>
                Strong
              </span>
            </div>
          </div>
        </section>

        <section id="pricing" className="lp-section">
          <h2 className="lp-section-title">Hosted pricing</h2>
          <p className="lp-section-sub">
            Start free by self-hosting, or let us run the rendering for you.
          </p>
          <div className="lp-pricing">
            {PRICING.map((tier) => (
              <div
                className={`lp-price-card${tier.featured ? " featured" : ""}`}
                key={tier.name}
              >
                {tier.featured && <span className="lp-badge">Most popular</span>}
                <h3>{tier.name}</h3>
                <div className="lp-price">
                  <span className="lp-price-amount">{tier.price}</span>
                  <span className="lp-price-cadence">{tier.cadence}</span>
                </div>
                <p className="lp-price-blurb">{tier.blurb}</p>
                <ul className="lp-price-features">
                  {tier.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                {tier.cta.external ? (
                  <a
                    className="lp-price-cta"
                    href={tier.cta.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tier.cta.label}
                  </a>
                ) : (
                  <Link className="lp-price-cta" to={tier.cta.href}>
                    {tier.cta.label}
                  </Link>
                )}
              </div>
            ))}
          </div>
          <p className="lp-section-sub lp-pricing-note">
            Hosted pricing is indicative while we finalize launch tiers. Prefer
            full control? Self-hosting is always free.
          </p>
        </section>

        <section className="lp-examples lp-section" aria-label="Example renders">
          <div className="lp-examples-head">
            <div>
              <h2>Example renders</h2>
              <p>Local videos created with this workspace.</p>
            </div>
            <Link to="/studio">Open studio</Link>
          </div>
          <div className="lp-example-empty">
            Exports will appear here after the first local render.
          </div>
        </section>

        <section className="lp-cta">
          <h2>Open source. Run it yourself.</h2>
          <p>
            Popcorn Ready is open source. Clone it, bring your own model keys,
            and render unlimited videos on your own machine.
          </p>
          <pre className="lp-code">
            <code>
              git clone {GITHUB_URL}.git{"\n"}
              cd popcornready && pnpm install && pnpm dev
            </code>
          </pre>
          <div className="lp-cta-buttons">
            <a
              className="lp-price-cta featured"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              View on GitHub &rarr;
            </a>
            <Link className="lp-price-cta" to="/studio">
              Open the studio
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span>Popcorn Ready &mdash; AI-native video editor</span>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          {GITHUB_URL.replace("https://", "")}
        </a>
      </footer>
    </div>
  );
}
