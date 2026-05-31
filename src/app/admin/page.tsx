import Link from "next/link";

const ADMIN_FEATURES = [
  {
    title: "Generation runs",
    status: "Planned",
    body: "Inspect active and recent video generation runs by project, stage, owner, duration, and terminal state.",
  },
  {
    title: "Job queue",
    status: "Planned",
    body: "View queued, running, retrying, failed, and canceled jobs across generation, assets, audio, and export.",
  },
  {
    title: "Provider health",
    status: "Planned",
    body: "Track image, video, audio, and LLM provider latency, failures, throttling, and last successful call.",
  },
  {
    title: "Asset storage",
    status: "Local v1",
    body: "Review generated assets stored locally today, with room to swap URLs and object IDs to S3 later.",
  },
  {
    title: "Style presets",
    status: "Planned",
    body: "Manage defaults for visual style, narration, captions, platform format, and hidden advanced configuration.",
  },
  {
    title: "Safety and audit",
    status: "Planned",
    body: "Show redacted provider errors, retry history, prompt provenance, request IDs, and operator notes.",
  },
];

const FLOW_STAGES = [
  {
    step: "01",
    title: "Brief intake",
    state: "Complete",
    body: "Idea, duration, aspect ratio, and default generation settings are saved.",
    progress: 100,
  },
  {
    step: "02",
    title: "Creative plan",
    state: "Complete",
    body: "The script, beat list, and required asset plan are ready.",
    progress: 100,
  },
  {
    step: "03",
    title: "Visual generation",
    state: "Running",
    body: "Generating visual 3 of 8. Provider calls can take several minutes.",
    progress: 38,
  },
  {
    step: "04",
    title: "Audio generation",
    state: "Queued",
    body: "Narration and supporting audio start after the visual plan is stable.",
    progress: 0,
  },
  {
    step: "05",
    title: "Timeline assembly",
    state: "Queued",
    body: "Generated assets will be converted into timed scenes and captions.",
    progress: 0,
  },
  {
    step: "06",
    title: "Export",
    state: "Queued",
    body: "The final MP4 render begins after review checks pass.",
    progress: 0,
  },
];

const LOADING_STATES = [
  {
    title: "Queued skeleton",
    label: "Waiting for worker",
    body: "Use before a stage starts. The user sees what will happen next without implying progress.",
    className: "queued",
  },
  {
    title: "Active stage",
    label: "Generating visual 3 of 8",
    body: "Use while the current stage is doing work and the app has useful context to show.",
    className: "active",
  },
  {
    title: "Provider wait",
    label: "Waiting on video model",
    body: "Use during long image, video, or audio calls where provider progress is not granular.",
    className: "waiting",
  },
  {
    title: "Artifact ready",
    label: "Preview available",
    body: "Use as soon as a generated image, audio clip, timeline, or export can be inspected.",
    className: "ready",
  },
  {
    title: "Retryable failure",
    label: "OpenAI image timed out",
    body: "Use when the failed item can be retried without discarding completed work.",
    className: "failed",
  },
  {
    title: "Terminal success",
    label: "Video ready",
    body: "Use when the export artifact exists and the user can review or download the video.",
    className: "done",
  },
];

const SWATCHES = [
  { name: "Background", value: "#0d0f12" },
  { name: "Panel", value: "#15181d" },
  { name: "Accent", value: "#ff6a3d" },
  { name: "Info", value: "#4da3ff" },
  { name: "Success", value: "#4ad295" },
  { name: "Warning", value: "#f5c451" },
];

export default function AdminPage() {
  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <Link href="/" className="admin-wordmark">
          aividi
        </Link>
        <nav>
          <Link href="/studio">Studio</Link>
          <Link href="/">Landing</Link>
        </nav>
      </header>

      <section className="admin-hero">
        <div>
          <span className="admin-eyebrow">Operator console</span>
          <h1>Admin surface and generation state guide</h1>
          <p>
            A working style guide for the internal pages that will make long
            video generation runs visible, diagnosable, and recoverable.
          </p>
        </div>
        <div className="admin-hero-panel">
          <span className="admin-metric-label">Active run</span>
          <strong>Visual generation</strong>
          <div className="admin-progress-bar" aria-label="Example run progress">
            <span style={{ width: "38%" }} />
          </div>
          <p>Generating visual 3 of 8. Next poll in 2s.</p>
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-section-head">
          <div>
            <span className="admin-eyebrow">Admin modules</span>
            <h2>Feature set</h2>
          </div>
          <span className="admin-status-pill">Planning view</span>
        </div>
        <div className="admin-feature-grid">
          {ADMIN_FEATURES.map((feature) => (
            <article className="admin-card" key={feature.title}>
              <div className="admin-card-head">
                <h3>{feature.title}</h3>
                <span>{feature.status}</span>
              </div>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-section-head">
          <div>
            <span className="admin-eyebrow">Generation flow</span>
            <h2>Stage timeline</h2>
          </div>
          <span className="admin-status-pill live">Example state</span>
        </div>
        <div className="admin-flow">
          {FLOW_STAGES.map((stage) => (
            <article
              className={`admin-stage ${stage.state.toLowerCase()}`}
              key={stage.step}
            >
              <div className="admin-stage-index">{stage.step}</div>
              <div>
                <div className="admin-stage-title">
                  <h3>{stage.title}</h3>
                  <span>{stage.state}</span>
                </div>
                <p>{stage.body}</p>
                <div className="admin-progress-bar small">
                  <span style={{ width: `${stage.progress}%` }} />
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-section-head">
          <div>
            <span className="admin-eyebrow">Style guide</span>
            <h2>Loading states</h2>
          </div>
        </div>
        <div className="admin-loading-grid">
          {LOADING_STATES.map((state) => (
            <article className={`admin-loading-card ${state.className}`} key={state.title}>
              <div className="admin-loading-preview">
                <span />
                <span />
                <span />
              </div>
              <div className="admin-card-head">
                <h3>{state.title}</h3>
                <span>{state.label}</span>
              </div>
              <p>{state.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-section admin-style-row">
        <div>
          <span className="admin-eyebrow">Style guide</span>
          <h2>Tokens and controls</h2>
          <p>
            Keep admin pages dense, readable, and status-forward. Use restrained
            panels, clear badges, and progress bars only when they carry real
            state.
          </p>
        </div>
        <div className="admin-swatch-grid">
          {SWATCHES.map((swatch) => (
            <div className="admin-swatch" key={swatch.name}>
              <span style={{ background: swatch.value }} />
              <div>
                <strong>{swatch.name}</strong>
                <code>{swatch.value}</code>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
