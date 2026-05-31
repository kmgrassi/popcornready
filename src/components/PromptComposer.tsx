"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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

export function PromptComposer() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateIndex, setTemplateIndex] = useState(0);
  const activeTemplate = TEMPLATES[templateIndex];

  useEffect(() => {
    const interval = window.setInterval(() => {
      setTemplateIndex((current) => (current + 1) % TEMPLATES.length);
    }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  async function start(promptOverride?: string) {
    const goal = (promptOverride ?? value).trim();
    if (!goal || submitting) return;
    setValue(goal);
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
        <span className="lp-templates-label">
          <span className="lp-template-icon" aria-hidden="true">
            {activeTemplate.icon}
          </span>
          Template idea
        </span>
        <div className="lp-template-roller" aria-label="Video templates">
          <div
            key={activeTemplate.label}
            className="lp-template-item"
            title={activeTemplate.prompt}
          >
            <span>{activeTemplate.text}</span>
          </div>
        </div>
        <button
          type="button"
          className="lp-template-generate"
          onClick={() => start(activeTemplate.prompt)}
          disabled={submitting}
        >
          Use template
        </button>
      </div>
      <button
        type="button"
        className="lp-prompt-submit"
        onClick={() => start()}
        disabled={!value.trim() || submitting}
      >
        {submitting ? "Starting your video…" : "Create my video →"}
      </button>
      {error && (
        <p className="lp-prompt-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
