import Link from "next/link";
import { promises as fs } from "fs";
import path from "path";
import { PromptComposer } from "@/components/PromptComposer";

const GITHUB_URL = "https://github.com/kmgrassi/aividi";
const EXPORT_DIR = path.join(process.cwd(), "public", "exports");

const STEPS = [
  {
    n: "1",
    title: "Write a brief",
    body: "Describe the video you want — your goal, length, style, and audience. One prompt is enough to start.",
  },
  {
    n: "2",
    title: "AI plans the beats",
    body: "Claude turns your intent into a structured plan: a hook, the beats that carry it, and the payoff.",
  },
  {
    n: "3",
    title: "Generate & assemble",
    body: "aividi generates a visual for each beat (or uses your own clips), assembles an editable timeline, and a critic improves the cut.",
  },
  {
    n: "4",
    title: "Deterministic render",
    body: "Export a real MP4 via Remotion. The AI only edits structured data — it never touches raw video.",
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
    body: "“Make the hook punchier,” “shorten to 15s,” “add captions” — every message becomes validated timeline edits.",
  },
  {
    title: "Inspectable & safe",
    body: "Every cut traces back to source clips, prompts, and patches. Bad model output is clamped, not rendered.",
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
      "Agent API (preview)",
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

interface LandingExampleVideo {
  id: string;
  url: string;
  filename: string;
}

function exportGroupId(filename: string): string {
  return filename.replace(/_overlay\.mp4$/, "").replace(/\.mp4$/, "");
}

async function getExampleVideos(): Promise<LandingExampleVideo[]> {
  try {
    const entries = await fs.readdir(EXPORT_DIR, { withFileTypes: true });
    const groups = new Map<
      string,
      { filename: string; url: string; mtimeMs: number; overlay: boolean }
    >();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".mp4")) continue;
      const filePath = path.join(EXPORT_DIR, entry.name);
      const stat = await fs.stat(filePath);
      const id = exportGroupId(entry.name);
      const overlay = entry.name.endsWith("_overlay.mp4");
      const current = groups.get(id);
      if (!current || (overlay && !current.overlay) || stat.mtimeMs > current.mtimeMs) {
        groups.set(id, {
          filename: entry.name,
          url: `/exports/${entry.name}`,
          mtimeMs: stat.mtimeMs,
          overlay,
        });
      }
    }

    return [...groups.entries()]
      .map(([id, video]) => ({ id, url: video.url, filename: video.filename }))
      .sort((a, b) => {
        const aVideo = groups.get(a.id)!;
        const bVideo = groups.get(b.id)!;
        return bVideo.mtimeMs - aVideo.mtimeMs;
      })
      .slice(0, 8);
  } catch {
    return [];
  }
}

export default async function LandingPage() {
  const exampleVideos = await getExampleVideos();

  return (
    <div className="landing">
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <span className="lp-logo">aividi</span>
          <nav className="lp-nav-links">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link href="/admin">Admin</Link>
            <Link className="lp-nav-cta" href="/studio">
              Open studio
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <span className="lp-eyebrow">AI-native video studio</span>
          <h1>
            Describe it. <span className="lp-accent">aividi cuts it.</span>
          </h1>
          <p className="lp-lede">
            Describe the video you want and aividi plans the beats, generates the
            visuals, and cuts a finished 30-second video &mdash; no footage
            required. The AI plans and patches; rendering stays deterministic.
          </p>

          <PromptComposer />
        </section>

        <section className="lp-examples" aria-label="Example renders">
          <div className="lp-examples-head">
            <div>
              <h2>Example renders</h2>
              <p>Local videos created with this workspace.</p>
            </div>
            <Link href="/studio">Open studio</Link>
          </div>
          {exampleVideos.length > 0 ? (
            <div className="lp-example-grid">
              {exampleVideos.map((video) => (
                <a
                  className="lp-example-tile"
                  href={video.url}
                  target="_blank"
                  rel="noreferrer"
                  key={video.id}
                >
                  <video src={video.url} muted playsInline preload="metadata" />
                  <span>{video.filename.replace(/_overlay\.mp4|\.mp4/g, "")}</span>
                </a>
              ))}
            </div>
          ) : (
            <div className="lp-example-empty">
              Exports will appear here after the first local render.
            </div>
          )}
        </section>

        <section id="how" className="lp-section">
          <h2 className="lp-section-title">How it works</h2>
          <p className="lp-section-sub">
            One loop: brief &rarr; plan &rarr; timeline &rarr; render.
          </p>
          <div className="lp-steps">
            {STEPS.map((s) => (
              <div className="lp-step" key={s.n}>
                <span className="lp-step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-section">
          <h2 className="lp-section-title">What it does</h2>
          <div className="lp-grid">
            {FEATURES.map((f) => (
              <div className="lp-card" key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
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
                  {tier.features.map((feat) => (
                    <li key={feat}>{feat}</li>
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
                  <Link className="lp-price-cta" href={tier.cta.href}>
                    {tier.cta.label}
                  </Link>
                )}
              </div>
            ))}
          </div>
          <p className="lp-section-sub" style={{ marginTop: 16 }}>
            Hosted pricing is indicative while we finalize launch tiers. Prefer
            full control? Self-hosting is always free.
          </p>
        </section>

        <section className="lp-cta">
          <h2>Open source. Run it yourself.</h2>
          <p>
            aividi is open source. Clone it, bring your own model keys, and
            render unlimited videos on your own machine.
          </p>
          <pre className="lp-code">
            <code>
              git clone {GITHUB_URL}.git{"\n"}
              cd aividi && npm install && npm run dev
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
            <Link className="lp-price-cta" href="/studio">
              Open the studio
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span>aividi &mdash; AI-native video editor</span>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          {GITHUB_URL.replace("https://", "")}
        </a>
      </footer>
    </div>
  );
}
