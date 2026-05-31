import React from "react";
import { AspectRatio, StoryContext } from "@/lib/types";

interface BriefPanelProps {
  aspect: AspectRatio;
  busy: boolean;
  clipsCount: number;
  goal: string;
  hasLibraryGeneration: boolean;
  storyContext: StoryContext;
  style: string;
  targetLength: number;
  setAspect: (value: AspectRatio) => void;
  setGoal: (value: string) => void;
  setStyle: (value: string) => void;
  setTargetLength: (value: number) => void;
  setStoryField: <K extends keyof StoryContext>(
    key: K,
    value: StoryContext[K]
  ) => void;
  onGenerate: () => void;
  onOneShot?: () => void;
}

export function BriefPanel({
  aspect,
  busy,
  clipsCount,
  goal,
  hasLibraryGeneration,
  storyContext,
  style,
  targetLength,
  setAspect,
  setGoal,
  setStyle,
  setTargetLength,
  setStoryField,
  onGenerate,
  onOneShot,
}: BriefPanelProps) {
  const canCreateFromPrompt = !!onOneShot;

  return (
    <>
      <h2>2 · Brief</h2>
      <label>Creative goal / script</label>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="e.g. A 30s ad that hooks fast, shows the problem, demos the product, and ends with a strong CTA."
      />
      <div className="row" style={{ marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <label>Length (s)</label>
          <input
            type="number"
            value={targetLength}
            onChange={(e) => setTargetLength(Number(e.target.value))}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label>Aspect</label>
          <select
            value={aspect}
            onChange={(e) => setAspect(e.target.value as AspectRatio)}
          >
            <option value="9:16">9:16</option>
            <option value="16:9">16:9</option>
            <option value="1:1">1:1</option>
          </select>
        </div>
      </div>
      <label>Style</label>
      <input value={style} onChange={(e) => setStyle(e.target.value)} />

      <h2>Story context</h2>
      <div className="row" style={{ marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <label>Audience</label>
          <input
            value={storyContext.audience || ""}
            onChange={(e) => setStoryField("audience", e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label>Platform</label>
          <select
            value={storyContext.platform || "general"}
            onChange={(e) =>
              setStoryField("platform", e.target.value as StoryContext["platform"])
            }
          >
            <option value="general">General</option>
            <option value="youtube">YouTube</option>
            <option value="tiktok">TikTok</option>
            <option value="reels">Reels</option>
            <option value="facebook">Facebook</option>
            <option value="vimeo">Vimeo</option>
          </select>
        </div>
      </div>
      <label>Story format</label>
      <select
        value={storyContext.format || "mystery_to_model"}
        onChange={(e) =>
          setStoryField("format", e.target.value as StoryContext["format"])
        }
      >
        <option value="mystery_to_model">Mystery → model</option>
        <option value="visual_reveal">Visual reveal</option>
        <option value="challenge">Challenge</option>
        <option value="misconception">Misconception</option>
        <option value="animated_explainer">Animated explainer</option>
        <option value="classroom_demo">Classroom demo</option>
        <option value="aesthetic_montage">Aesthetic montage</option>
      </select>
      <label>Hook question</label>
      <input
        value={storyContext.hookQuestion || ""}
        onChange={(e) => setStoryField("hookQuestion", e.target.value)}
      />
      <label>Strongest visual</label>
      <input
        value={storyContext.strongestVisual || ""}
        onChange={(e) => setStoryField("strongestVisual", e.target.value)}
      />
      <label>One big idea</label>
      <input
        value={storyContext.oneBigIdea || ""}
        onChange={(e) => setStoryField("oneBigIdea", e.target.value)}
      />
      <label>Payoff</label>
      <input
        value={storyContext.payoff || ""}
        onChange={(e) => setStoryField("payoff", e.target.value)}
      />
      <label>Caveat / trust note</label>
      <input
        value={storyContext.caveat || ""}
        onChange={(e) => setStoryField("caveat", e.target.value)}
      />
      <div className="row" style={{ marginTop: 10 }}>
        {canCreateFromPrompt && (
          <button
            onClick={onOneShot}
            disabled={busy || !goal.trim()}
            title="Generate visuals from the prompt and cut a video — no uploads needed"
          >
            Create video from prompt
          </button>
        )}
        <button
          className={canCreateFromPrompt ? "secondary" : undefined}
          onClick={onGenerate}
          disabled={busy || !hasLibraryGeneration || !goal.trim()}
          title={
            canCreateFromPrompt ? "Cut from your uploaded/generated clips" : undefined
          }
        >
          {canCreateFromPrompt ? "Cut from my clips" : "Generate rough cut"}
        </button>
      </div>
      {canCreateFromPrompt && (
        <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          “Create video from prompt” generates a visual for each beat — no clips
          required. “Cut from my clips” uses your library.
        </p>
      )}
    </>
  );
}
