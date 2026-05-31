"use client";

import React, { useState } from "react";
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

export function PromptComposer() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    const goal = value.trim();
    if (!goal || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // The landing prompt is "prompt-only": send the goal plus the same
      // hidden advanced defaults the studio would have used, so the run is
      // configured identically whether it is started from here or from the
      // editor.
      const response = await fetch(
        "/api/v1/projects/default/generation-runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: goal,
            targetLengthSec: 30,
            style: "fast-paced social ad",
            aspectRatio: "9:16",
          }),
        }
      );
      const data = await response.json();
      if (!response.ok || !data.run?.runId) {
        throw new Error(
          data?.error?.message || "Unable to start video generation."
        );
      }
      router.push(
        `/studio?runId=${encodeURIComponent(data.run.runId)}&goal=${encodeURIComponent(goal)}&length=30`
      );
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
          ? "Starting your video…"
          : "Create my 30-second video →"}
      </button>
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
