"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  GATEABLE_GENERATION_STAGE_TYPES,
  GENERATION_STAGE_LABELS,
  GateableGenerationStageType,
} from "@/lib/v1/types";

const FEATURED_TEMPLATE: { icon: string; label: string; text: string; prompt: string } = {
  icon: "🏆",
  label: "Movie dream montage",
  text: "The movie-loving boy who trades clunky editing tools for Popcorn Ready and wins Best Picture",
  prompt:
    "Create a 30-second cinematic story. Open on a 10-year-old movie-loving boy in his bedroom late at night, hunched over a computer running traditional video editing software — the screen is a cluttered, complex timeline crammed with dozens of video clips he is struggling to splice together. He looks frustrated and overwhelmed as the edit fights him. Then he discovers the website “Popcorn Ready,” and everything changes. Build a montage with gradually rising orchestral music as he creates a movie, goes from idea to production, and sees it released to adoring fans. Show him as a famous filmmaker at a packed premiere, then at an awards show selected for Best Picture as he walks up to the microphone and begins, “I would like to thank...”. End where it began: he is slumped asleep over his desk, then stirs, lifts his head, and looks up to see the Popcorn Ready screen glowing on his computer — the movie of his dreams can now be made.",
};

const TEMPLATES: { icon: string; label: string; text: string; prompt: string }[] = [
  {
    icon: "🍂",
    label: "Leaf blower cleanup",
    text: "Generate a video of a homeowner clearing a leaf-covered driveway into a clean outdoor space.",
    prompt:
      "A homeowner uses a leaf blower to turn a messy driveway covered in leaves into a clean, satisfying outdoor space. Start with the frustrating mess, show the tool in action, and end with a crisp before-and-after reveal.",
  },
  {
    icon: "🥐",
    label: "Bakery morning rush",
    text: "Generate a video of a small bakery preparing for the morning rush.",
    prompt:
      "A small bakery prepares for the morning rush. Show the quiet early morning, the baking process, customers arriving, and end with a warm moment of someone enjoying a fresh pastry.",
  },
  {
    icon: "🎧",
    label: "Headphones focus",
    text: "Generate a video of a student finding focus in a chaotic coffee shop with noise-canceling headphones.",
    prompt:
      "A student uses noise-canceling headphones to get focused in a chaotic coffee shop. Start with distraction, show the moment the headphones go on, and end with the student finishing their work confidently.",
  },
  {
    icon: "🎾",
    label: "Park fetch launcher",
    text: "Generate a video of a dog owner making fetch easier with an automatic ball launcher.",
    prompt:
      "A dog owner uses an automatic ball launcher at the park. Begin with an energetic dog begging to play, show the launcher making fetch easier, and end with both the dog and owner happy and tired.",
  },
  {
    icon: "🌿",
    label: "Backyard trimmer",
    text: "Generate a video of an overgrown backyard becoming guest-ready with a cordless trimmer.",
    prompt:
      "A gardener uses a cordless trimmer to clean up an overgrown backyard. Start with tangled weeds and messy edges, show quick progress, and end with a polished backyard ready for guests.",
  },
  {
    icon: "🥗",
    label: "Lunch prep system",
    text: "Generate a video of a busy parent turning a chaotic kitchen into organized weekly lunches.",
    prompt:
      "A busy parent uses a meal-prep container system to organize lunches for the week. Start with a chaotic kitchen, show the simple system coming together, and end with a calm Monday morning.",
  },
  {
    icon: "🚲",
    label: "Cyclist flat fix",
    text: "Generate a video of a cyclist fixing a roadside flat with a compact tire repair kit.",
    prompt:
      "A cyclist discovers a compact tire repair kit during a roadside flat. Start with the problem, show the quick fix, and end with the cyclist back on the road at sunset.",
  },
  {
    icon: "💡",
    label: "Desk setup upgrade",
    text: "Generate a video of a remote worker transforming a cluttered desk into a calm productive setup.",
    prompt:
      "A remote worker upgrades their desk setup with a monitor light, laptop stand, and clean cable organization. Start with a cluttered, uncomfortable workspace, show the transformation, and end with a calm productive setup.",
  },
  {
    icon: "🎬",
    label: "Backyard movie night",
    text: "Generate a video of a family setting up a backyard movie night under string lights.",
    prompt:
      "A family uses a portable projector for a backyard movie night. Start with an ordinary backyard, show the setup coming together, and end with everyone watching the movie under string lights.",
  },
  {
    icon: "🏋️",
    label: "Smart jump rope habit",
    text: "Generate a video of a fitness beginner building confidence with a smart jump rope workout.",
    prompt:
      "A fitness beginner uses a smart jump rope to build a simple daily workout habit. Start with hesitation, show small progress and encouraging feedback, and end with the person feeling proud after completing the session.",
  },
];

const GENERATION_STAGES = [
  {
    label: "Planning",
    detail: "Turning the prompt into cinematic beats.",
  },
  {
    label: "Generating clips",
    detail: "Creating visual shots for each beat.",
  },
  {
    label: "Scoring",
    detail: "Creating an instrumental soundtrack when audio is available.",
  },
  {
    label: "Assembling",
    detail: "Building the timeline from generated media.",
  },
  {
    label: "Reviewing",
    detail: "Checking the cut and applying polish.",
  },
  {
    label: "Opening studio",
    detail: "Loading the editable timeline.",
  },
];

const REVIEW_STAGE_DETAILS: Record<GateableGenerationStageType, string> = {
  brief_intake: "Confirm the brief before planning starts.",
  creative_plan: "Review story beats and creative direction.",
  asset_generation: "Inspect generated visuals before assembly.",
  audio_generation: "Check music and narration choices.",
  timeline_assembly: "Review the cut before quality checks.",
  quality_review: "Inspect critic notes and polish.",
  export: "Approve the render step before final output.",
};

export function PromptComposer() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateIndex, setTemplateIndex] = useState(0);
  const activeTemplate = TEMPLATES[templateIndex];
  const [activeStage, setActiveStage] = useState(0);
  const [reviewGates, setReviewGates] = useState<GateableGenerationStageType[]>([]);
  // Generation length in seconds — the first real run "config" surfaced in the
  // settings panel that extends the prompt box.
  const [lengthSec, setLengthSec] = useState(30);
  // Settings panel that extends the prompt box (opened from the cog on the
  // Create button); collapsed by default. More config moves in over time.
  const [configOpen, setConfigOpen] = useState(false);
  // Scaffold only: captures a chosen reference image filename for display. It is
  // not yet uploaded or forwarded to the one-shot route — wiring it into the
  // request body + per-beat referencePaths is a follow-up.
  const [referenceImageName, setReferenceImageName] = useState<string | null>(null);

  useEffect(() => {
    if (!submitting) {
      setActiveStage(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      if (elapsedSec > 120) setActiveStage(4);
      else if (elapsedSec > 75) setActiveStage(3);
      else if (elapsedSec > 35) setActiveStage(2);
      else if (elapsedSec > 8) setActiveStage(1);
      else setActiveStage(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [submitting]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setTemplateIndex((current) => (current + 1) % TEMPLATES.length);
    }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  function toggleReviewGate(stage: GateableGenerationStageType) {
    setReviewGates((current) =>
      current.includes(stage)
        ? current.filter((candidate) => candidate !== stage)
        : [...current, stage]
    );
  }

  function selectAllReviewGates() {
    setReviewGates((current) =>
      current.length === GATEABLE_GENERATION_STAGE_TYPES.length
        ? []
        : [...GATEABLE_GENERATION_STAGE_TYPES]
    );
  }

  async function start(promptOverride?: string) {
    const goal = (promptOverride ?? value).trim();
    if (!goal || submitting) return;
    setValue(goal);
    setSubmitting(true);
    setError(null);
    try {
      // The one-shot route runs the full planner -> generation -> assembly
      // pipeline in a single call and persists the project, so the editor can
      // open immediately. The v1 generation-runs endpoint only seeds a queued
      // run today (real execution is a later scope), so submitting there would
      // leave the run queued forever; route landing generation here instead.
      // reviewGates is forwarded for forward-compatibility but the one-shot
      // pipeline does not yet honor per-stage review gating.
      const response = await fetch("/api/oneshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          targetLengthSec: lengthSec,
          style: "cinematic story",
          aspectRatio: "9:16",
          reviewGates,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.project) {
        throw new Error(
          data?.error?.message ||
            data?.error ||
            "Unable to generate your video."
        );
      }
      setActiveStage(5);
      router.push(
        `/studio?goal=${encodeURIComponent(goal)}&length=${lengthSec}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="lp-prompt">
      <button
        type="button"
        className="lp-featured-template"
        onClick={() => setValue(FEATURED_TEMPLATE.prompt)}
        disabled={submitting}
        title={FEATURED_TEMPLATE.prompt}
      >
        <span className="lp-featured-template-icon" aria-hidden="true">
          {FEATURED_TEMPLATE.icon}
        </span>
        <span className="lp-featured-template-copy">
          <span className="lp-featured-template-label">{FEATURED_TEMPLATE.label}</span>
          <span className="lp-featured-template-text">{FEATURED_TEMPLATE.text}</span>
        </span>
        <span className="lp-featured-template-cta" aria-hidden="true">
          Use this
        </span>
      </button>
      <label htmlFor="goal" className="lp-prompt-label">
        What&apos;s your video?
      </label>
      <textarea
        id="goal"
        className="lp-prompt-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. A social ad that hooks fast, shows the problem, demos the product, and ends with a strong CTA."
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
        }}
      />
      <div className="lp-templates">
        <span className="lp-templates-label">Template idea</span>
        <div className="lp-template-roller" aria-label="Video templates">
          <div
            key={activeTemplate.label}
            className="lp-template-item"
            title={activeTemplate.prompt}
          >
            <span className="lp-template-icon" aria-hidden="true">
              {activeTemplate.icon}
            </span>
            <span className="lp-template-text">{activeTemplate.text}</span>
          </div>
        </div>
        <button
          type="button"
          className="lp-template-generate"
          onClick={() => setValue(activeTemplate.prompt)}
          disabled={submitting}
        >
          Use template
        </button>
      </div>
      <div className="lp-submit">
        <div className="lp-submit-split">
          <button
            type="button"
            className="lp-prompt-submit"
            onClick={() => start()}
            disabled={!value.trim() || submitting}
          >
            {submitting
              ? "Starting your run..."
              : `Create my ${lengthSec}-second video`}
          </button>
          <button
            type="button"
            className="lp-submit-config-toggle"
            onClick={() => setConfigOpen((open) => !open)}
            disabled={submitting}
            aria-expanded={configOpen}
            aria-controls="lp-config-panel"
            aria-label="Generation settings"
            title="Generation settings"
          >
            <svg
              className="lp-cog"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
        {configOpen && (
          <div id="lp-config-panel" className="lp-config-panel">
            <div className="lp-config-panel-head">Settings</div>
            <section className="lp-config-section">
              <h3 className="lp-config-heading">Length</h3>
              <p className="lp-config-hint">
                How long the finished video should be.
              </p>
              <select
                className="lp-config-select"
                value={lengthSec}
                onChange={(e) => setLengthSec(Number(e.target.value))}
                disabled={submitting}
              >
                <option value={15}>15 seconds</option>
                <option value={30}>30 seconds</option>
                <option value={60}>60 seconds</option>
              </select>
            </section>
            <section className="lp-config-section">
              <h3 className="lp-config-heading">Default review checkpoints</h3>
              <p className="lp-config-hint">
                Pre-select where the one-shot run should pause for your review.
                Leave all off to generate end to end.
              </p>
              <div className="lp-review-options">
                {GATEABLE_GENERATION_STAGE_TYPES.map((stage) => {
                  const checked = reviewGates.includes(stage);
                  return (
                    <label className="lp-review-option" key={stage}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleReviewGate(stage)}
                        disabled={submitting}
                      />
                      <span>
                        <strong>{GENERATION_STAGE_LABELS[stage]}</strong>
                        <small>{REVIEW_STAGE_DETAILS[stage]}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                className="lp-config-link"
                onClick={selectAllReviewGates}
                disabled={submitting}
              >
                {reviewGates.length === GATEABLE_GENERATION_STAGE_TYPES.length
                  ? "Clear all reviews"
                  : "Review every step"}
              </button>
            </section>

            <section className="lp-config-section">
              <h3 className="lp-config-heading">Reference image</h3>
              <p className="lp-config-hint">
                Optional. Upload an image (for example a Popcorn Ready
                screenshot) to anchor a shot. Not yet wired into generation —
                this is a placeholder for the upcoming image-to-video input.
              </p>
              <label className="lp-config-upload">
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) =>
                    setReferenceImageName(e.target.files?.[0]?.name ?? null)
                  }
                  disabled={submitting}
                />
                <span>Upload image</span>
              </label>
              {referenceImageName && (
                <p className="lp-config-upload-name">
                  Selected: {referenceImageName}
                </p>
              )}
            </section>
          </div>
        )}
      </div>
      {submitting && (
        <div className="lp-generation-progress" aria-live="polite">
          <div className="lp-generation-progress-head">
            <span>One-shot generation</span>
            <strong>{GENERATION_STAGES[activeStage].label}</strong>
          </div>
          <ol className="lp-generation-steps">
            {GENERATION_STAGES.map((stage, index) => {
              const state =
                index < activeStage
                  ? "complete"
                  : index === activeStage
                    ? "active"
                    : "pending";
              return (
                <li className={`lp-generation-step ${state}`} key={stage.label}>
                  <span className="lp-generation-dot" />
                  <span>
                    <strong>{stage.label}</strong>
                    <small>{stage.detail}</small>
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="lp-generation-note">
            This request runs the one-shot pipeline in a single server call, so
            stage timing is estimated until backend progress is wired into the
            one-shot route.
          </p>
        </div>
      )}
      {error && (
        <p className="lp-prompt-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
