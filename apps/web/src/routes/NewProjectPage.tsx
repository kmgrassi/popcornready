import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  GATEABLE_GENERATION_STAGE_TYPES,
  GENERATION_STAGE_LABELS,
  type GateableGenerationStageType,
} from "@popcorn/shared/v1/types";
import type { AspectRatio } from "@popcorn/shared/types";
import { ApiClientError, v1Api } from "../lib/api-client";

const TEMPLATES = [
  {
    label: "Launch teaser",
    prompt:
      "Create a punchy launch teaser that opens with the problem, introduces the product, shows the transformation, and ends with a confident call to action.",
  },
  {
    label: "Event recap",
    prompt:
      "Cut a warm event recap with an energetic opening, quick human moments, a clear sense of place, and a polished ending.",
  },
  {
    label: "Product demo",
    prompt:
      "Build a concise product demo that shows the before state, the product in use, the key benefit, and a satisfying final result.",
  },
];

const PLATFORMS = [
  { label: "TikTok / Reels", platform: "tiktok", aspect: "9:16", length: 30 },
  { label: "YouTube", platform: "youtube", aspect: "16:9", length: 60 },
  { label: "Square social", platform: "general", aspect: "1:1", length: 30 },
] as const;

const REVIEW_STAGE_DETAILS: Record<GateableGenerationStageType, string> = {
  brief_intake: "Confirm the brief before planning starts.",
  creative_plan: "Review story beats and creative direction.",
  asset_generation: "Inspect generated visuals before assembly.",
  audio_generation: "Check music and narration choices.",
  timeline_assembly: "Review the cut before quality checks.",
  quality_review: "Inspect critic notes and polish.",
  export: "Approve the render step before final output.",
};

type WizardStep = 0 | 1 | 2 | 3;
type Platform = "general" | "youtube" | "tiktok" | "reels" | "facebook" | "vimeo";
type StoryFormat =
  | "mystery_to_model"
  | "visual_reveal"
  | "challenge"
  | "misconception"
  | "animated_explainer"
  | "classroom_demo"
  | "aesthetic_montage";

export function NewProjectPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>(0);
  const [files, setFiles] = useState<File[]>([]);
  const [projectName, setProjectName] = useState("");
  const [goal, setGoal] = useState("");
  const [targetLengthSec, setTargetLengthSec] = useState(30);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [format, setFormat] = useState<StoryFormat>("visual_reveal");
  const [style, setStyle] = useState("fast-paced social ad");
  const [audience, setAudience] = useState("");
  const [hook, setHook] = useState("");
  const [bigIdea, setBigIdea] = useState("");
  const [provider, setProvider] = useState("openai");
  const [seedKind, setSeedKind] = useState<"image" | "video">("image");
  const [seedSize, setSeedSize] = useState("1024x1792");
  const [reviewGates, setReviewGates] = useState<GateableGenerationStageType[]>([]);
  const [showCaptions, setShowCaptions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generatedProjectName = useMemo(() => {
    const trimmed = goal.trim();
    if (!trimmed) return "Untitled cut";
    const firstSentence = trimmed.split(/[.!?]/)[0]?.trim() || trimmed;
    return firstSentence.length > 64
      ? `${firstSentence.slice(0, 61).trim()}...`
      : firstSentence;
  }, [goal]);

  const canContinue = step === 0 || (step === 1 && goal.trim()) || step === 2 || step === 3;
  const canGenerate = goal.trim() && !submitting;

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  function toggleReviewGate(stage: GateableGenerationStageType) {
    setReviewGates((current) =>
      current.includes(stage)
        ? current.filter((candidate) => candidate !== stage)
        : [...current, stage]
    );
  }

  function applyPreset(preset: (typeof PLATFORMS)[number]) {
    setPlatform(preset.platform);
    setAspectRatio(preset.aspect as AspectRatio);
    setTargetLengthSec(preset.length);
  }

  async function generate() {
    if (!canGenerate) return;
    setSubmitting(true);
    setError(null);

    try {
      const brief = {
        goal: goal.trim(),
        targetLengthSec,
        aspectRatio,
        platform,
        format,
        style,
        audience: audience.trim() || undefined,
        constraints:
          hook.trim() || bigIdea.trim()
            ? {
                requiredBeats: [hook, bigIdea].map((value) => value.trim()).filter(Boolean),
              }
            : undefined,
      };
      const { project } = await v1Api.createProject({
        name: projectName.trim() || generatedProjectName,
        brief,
      });
      const { runId } = await v1Api.startPromptGenerationRun(project.id, {
        brief,
        mode: files.length > 0 ? "hybrid" : "prompt_only",
        allowGeneratedGapFill: true,
        provider,
        reviewGates,
        showCaptions,
        seedAsset: {
          kind: seedKind,
          provider,
          prompt: goal.trim(),
          description: goal.trim(),
          durationSec: seedKind === "image" ? 4 : 8,
          size: seedSize,
          preflightReviewIterations: 1,
        },
      });

      if (!runId) {
        throw new Error("Generation started without a run ID.");
      }

      navigate(`/projects/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(runId)}`);
    } catch (generateError) {
      const message =
        generateError instanceof ApiClientError || generateError instanceof Error
          ? generateError.message
          : "Could not start generation.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="new-project-page">
      <section className="new-project-head">
        <div>
          <p className="new-project-kicker">New project</p>
          <h1>Generate a rough cut</h1>
          <p className="muted">
            Start with the essentials, keep advanced controls folded away, and
            hand the brief to the V1 generation run model.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => navigate("/studio")}
          disabled={submitting}
        >
          Cancel
        </button>
      </section>

      <nav className="new-project-steps" aria-label="New project steps">
        {["Upload", "Describe", "Format", "Generate"].map((label, index) => (
          <button
            type="button"
            key={label}
            className={index === step ? "active" : undefined}
            onClick={() => setStep(index as WizardStep)}
            disabled={submitting}
          >
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </nav>

      <section className="new-project-panel">
        {step === 0 && (
          <div className="new-project-step">
            <h2>1 · Upload footage</h2>
            <p className="muted">
              Optional for this pass. Prompt-only generation is fully wired; selected
              clip names stay with the setup until the upload asset route is available.
            </p>
            <label className="new-project-drop">
              <input
                type="file"
                multiple
                accept="video/*,image/*,audio/*"
                onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                disabled={submitting}
              />
              <span>Choose clips</span>
              <small>Videos, images, or audio references</small>
            </label>
            {files.length > 0 && (
              <div className="new-project-file-list">
                {files.map((file) => (
                  <div key={`${file.name}-${file.size}`}>
                    <strong>{file.name}</strong>
                    <span>{Math.round(file.size / 1024)} KB</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="new-project-step">
            <h2>2 · Describe the goal</h2>
            <label>Project name</label>
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder={generatedProjectName}
              disabled={submitting}
            />
            <label>Creative goal / brief</label>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="e.g. A 30s ad that hooks fast, shows the problem, demos the product, and ends with a strong CTA."
              rows={6}
              disabled={submitting}
            />
            <div className="new-project-template-grid">
              {TEMPLATES.map((template) => (
                <button
                  type="button"
                  className="secondary"
                  key={template.label}
                  onClick={() => {
                    setProjectName(template.label);
                    setGoal(template.prompt);
                  }}
                  disabled={submitting}
                >
                  <strong>{template.label}</strong>
                  <span>{template.prompt}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="new-project-step">
            <h2>3 · Choose format</h2>
            <div className="new-project-preset-grid">
              {PLATFORMS.map((preset) => (
                <button
                  type="button"
                  className="secondary"
                  key={preset.label}
                  onClick={() => applyPreset(preset)}
                  disabled={submitting}
                >
                  <strong>{preset.label}</strong>
                  <span>
                    {preset.aspect}, {preset.length}s
                  </span>
                </button>
              ))}
            </div>
            <div className="new-project-field-row">
              <label>
                Length
                <select
                  value={targetLengthSec}
                  onChange={(event) => setTargetLengthSec(Number(event.target.value))}
                  disabled={submitting}
                >
                  <option value={15}>15 seconds</option>
                  <option value={30}>30 seconds</option>
                  <option value={60}>60 seconds</option>
                </select>
              </label>
              <label>
                Aspect
                <select
                  value={aspectRatio}
                  onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}
                  disabled={submitting}
                >
                  <option value="9:16">9:16</option>
                  <option value="16:9">16:9</option>
                  <option value="1:1">1:1</option>
                </select>
              </label>
            </div>
            <div className="new-project-field-row">
              <label>
                Platform
                <select
                  value={platform}
                  onChange={(event) => setPlatform(event.target.value as Platform)}
                  disabled={submitting}
                >
                  <option value="general">General</option>
                  <option value="youtube">YouTube</option>
                  <option value="tiktok">TikTok</option>
                  <option value="reels">Reels</option>
                  <option value="facebook">Facebook</option>
                  <option value="vimeo">Vimeo</option>
                </select>
              </label>
              <label>
                Story format
                <select
                  value={format}
                  onChange={(event) => setFormat(event.target.value as StoryFormat)}
                  disabled={submitting}
                >
                  <option value="mystery_to_model">Mystery to model</option>
                  <option value="visual_reveal">Visual reveal</option>
                  <option value="challenge">Challenge</option>
                  <option value="misconception">Misconception</option>
                  <option value="animated_explainer">Animated explainer</option>
                  <option value="classroom_demo">Classroom demo</option>
                  <option value="aesthetic_montage">Aesthetic montage</option>
                </select>
              </label>
            </div>
            <details className="advanced-panel">
              <summary>Advanced options</summary>
              <label>Audience</label>
              <input
                value={audience}
                onChange={(event) => setAudience(event.target.value)}
                disabled={submitting}
              />
              <label>Style</label>
              <input
                value={style}
                onChange={(event) => setStyle(event.target.value)}
                disabled={submitting}
              />
              <label>Hook / required opening beat</label>
              <input
                value={hook}
                onChange={(event) => setHook(event.target.value)}
                disabled={submitting}
              />
              <label>One big idea</label>
              <input
                value={bigIdea}
                onChange={(event) => setBigIdea(event.target.value)}
                disabled={submitting}
              />
            </details>
          </div>
        )}

        {step === 3 && (
          <div className="new-project-step">
            <h2>4 · Generate rough cut</h2>
            <div className="new-project-summary">
              <div>
                <span>Name</span>
                <strong>{projectName.trim() || generatedProjectName}</strong>
              </div>
              <div>
                <span>Format</span>
                <strong>
                  {aspectRatio}, {targetLengthSec}s
                </strong>
              </div>
              <div>
                <span>Source</span>
                <strong>{files.length > 0 ? `${files.length} selected` : "Prompt only"}</strong>
              </div>
            </div>
            <details className="advanced-panel">
              <summary>Advanced options</summary>
              <div className="new-project-field-row">
                <label>
                  Seed provider
                  <select
                    value={provider}
                    onChange={(event) => setProvider(event.target.value)}
                    disabled={submitting}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
                <label>
                  Seed kind
                  <select
                    value={seedKind}
                    onChange={(event) => setSeedKind(event.target.value as "image" | "video")}
                    disabled={submitting}
                  >
                    <option value="image">Image</option>
                    <option value="video">Video</option>
                  </select>
                </label>
              </div>
              <label>Seed size</label>
              <input
                value={seedSize}
                onChange={(event) => setSeedSize(event.target.value)}
                disabled={submitting}
              />
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={showCaptions}
                  onChange={(event) => setShowCaptions(event.target.checked)}
                  disabled={submitting}
                />
                Show captions
              </label>
              <div className="new-project-review-list">
                {GATEABLE_GENERATION_STAGE_TYPES.map((stage) => (
                  <label className="new-project-review-option" key={stage}>
                    <input
                      type="checkbox"
                      checked={reviewGates.includes(stage)}
                      onChange={() => toggleReviewGate(stage)}
                      disabled={submitting}
                    />
                    <span>
                      <strong>{GENERATION_STAGE_LABELS[stage]}</strong>
                      <small>{REVIEW_STAGE_DETAILS[stage]}</small>
                    </span>
                  </label>
                ))}
              </div>
            </details>
            {error && <p className="new-project-error">{error}</p>}
          </div>
        )}
      </section>

      <footer className="new-project-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => setStep((current) => Math.max(0, current - 1) as WizardStep)}
          disabled={step === 0 || submitting}
        >
          Back
        </button>
        {step < 3 ? (
          <button
            type="button"
            onClick={() => setStep((current) => Math.min(3, current + 1) as WizardStep)}
            disabled={!canContinue || submitting}
          >
            Continue
          </button>
        ) : (
          <button type="button" onClick={generate} disabled={!canGenerate}>
            {submitting ? "Starting run..." : "Generate rough cut"}
          </button>
        )}
      </footer>
    </main>
  );
}
