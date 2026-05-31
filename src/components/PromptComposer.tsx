"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const TEMPLATES: { label: string; prompt: string }[] = [
  {
    label: "Product intro",
    prompt:
      "Create a 30-second intro for a new product launch. Hook in the first 3 seconds, show what it does, and end with a strong call to action.",
  },
  {
    label: "Explainer",
    prompt:
      "Make a 30-second explainer that breaks down one big idea simply — open with a question, reveal the key insight, and finish with a satisfying payoff.",
  },
  {
    label: "Social ad",
    prompt:
      "A fast-paced 30-second social ad that shows a relatable problem, reveals the solution, and ends with a punchy call to action.",
  },
  {
    label: "Event hype reel",
    prompt:
      "A high-energy 30-second hype reel announcing an event — build anticipation with quick cuts and end on the date with a call to register.",
  },
  {
    label: "Movie dream montage",
    prompt:
      "Create a 30-second cinematic story. In the first 1-2 seconds, show a 10-year-old movie-loving boy in his bedroom late at night at a computer discovering the website “Popcorn Ready”. Then build a montage with gradually rising orchestral music as he creates a movie, goes from idea to production, and sees it released to adoring fans. Show him as a famous filmmaker at a packed premiere, then at an awards show selected for Best Movie as he walks up and starts, “I would like to thank...”. Cut to him waking up in bed, turning to his laptop, and finding Popcorn Ready open — the movie of his dreams can now be made.",
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

export function PromptComposer() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState(0);

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

  async function start() {
    const goal = value.trim();
    if (!goal || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/oneshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          targetLengthSec: 30,
          style: "cinematic story",
          aspectRatio: "9:16",
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
      router.push(`/studio?goal=${encodeURIComponent(goal)}&length=30`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="lp-prompt">
      <div className="lp-templates">
        <span className="lp-templates-label">Try a template:</span>
        {TEMPLATES.map((t) => (
          <button
            type="button"
            key={t.label}
            className="lp-chip"
            onClick={() => setValue(t.prompt)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label htmlFor="goal" className="lp-prompt-label">
        What&apos;s your 30-second video?
      </label>
      <textarea
        id="goal"
        className="lp-prompt-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. A 30-second ad that hooks fast, shows the problem, demos the product, and ends with a strong CTA."
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
        }}
      />
      <button
        type="button"
        className="lp-prompt-submit"
        onClick={start}
        disabled={!value.trim() || submitting}
      >
        {submitting
          ? "Generating your video…"
          : "Create my 30-second video →"}
      </button>
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
      <p className="lp-prompt-hint">
        No clips needed — Popcorn Ready generates the visuals and cuts the video for
        you. Bring your own keys for real footage, or use automatic visual
        generation to create it all.
      </p>
    </div>
  );
}
