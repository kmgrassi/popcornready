"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  AspectRatio,
  Clip,
  Project,
  StoryContext,
  Timeline,
  segmentDurationSec,
  timelineDurationSec,
} from "@/lib/types";
import { DEFAULT_STORY_CONTEXT } from "@/lib/story-context";

// Player relies on browser APIs — never SSR it.
const Preview = dynamic(() => import("./Preview"), { ssr: false });
const DEFAULT_IMAGE_SIZE = "1024x1536";
const DEFAULT_VIDEO_SIZE = "720x1280";

function defaultConsistencyModeForKind(kind: "image" | "video") {
  return kind === "video" ? "hero_frame" : "reference_pack";
}

interface ExportResult {
  url: string;
  silentUrl?: string;
  overlayUrl?: string | null;
  audioUrls?: string[];
}

async function readDuration(file: File): Promise<number> {
  if (file.type.startsWith("image/")) return 4;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v.duration) ? v.duration : 0);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    v.src = url;
  });
}

export function Editor() {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);

  // generate form
  const [goal, setGoal] = useState("");
  const [targetLength, setTargetLength] = useState(30);
  const [style, setStyle] = useState("fast-paced social ad");
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [storyContext, setStoryContext] = useState<StoryContext>(
    DEFAULT_STORY_CONTEXT
  );

  // upload form
  const [desc, setDesc] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // generative fill form
  const [assetProvider, setAssetProvider] = useState("openai");
  const [assetKind, setAssetKind] = useState<"image" | "video">("image");
  const [assetPrompt, setAssetPrompt] = useState("");
  const [assetDesc, setAssetDesc] = useState("");
  const [assetSize, setAssetSize] = useState(DEFAULT_IMAGE_SIZE);
  const [assetSeconds, setAssetSeconds] = useState(8);
  const [preflightReviewIterations, setPreflightReviewIterations] = useState(1);
  const [referenceClipIds, setReferenceClipIds] = useState<string[]>([]);
  const [characterProfileIds, setCharacterProfileIds] = useState<string[]>([]);
  const [consistencyMode, setConsistencyMode] = useState("prompt_only");
  const [shotDeltaPrompt, setShotDeltaPrompt] = useState("");

  // chat
  const [message, setMessage] = useState("");
  const [selectedAudioClipId, setSelectedAudioClipId] = useState("");

  useEffect(() => {
    fetch("/api/project")
      .then((r) => r.json())
      .then((d) => {
        setProject(d.project);
        if (d.project?.storyContext) setStoryContext(d.project.storyContext);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const clips = project?.clips ?? [];
  const timeline = project?.timeline ?? null;
  const audioClips = useMemo(
    () => clips.filter((c) => c.kind === "audio"),
    [clips]
  );

  useEffect(() => {
    setSelectedAudioClipId((current) => {
      if (current && audioClips.some((clip) => clip.id === current)) {
        return current;
      }
      return audioClips.length === 1 ? audioClips[0].id : "";
    });
  }, [audioClips]);

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    setBusy("Uploading clip…");
    try {
      const durationSec = await readDuration(file);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("durationSec", String(durationSec));
      fd.append("description", desc);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setProject(data.project);
      setDesc("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleGenerate() {
    setError(null);
    setExportResult(null);
    setBusy("Planning beats, selecting clips, running the critic…");
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          targetLengthSec: targetLength,
          style,
          aspectRatio: aspect,
          storyContext,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setProject(data.project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleGenerateAsset() {
    if (!assetPrompt.trim()) return;
    setError(null);
    setBusy(
      assetKind === "video"
        ? "Reviewing prompt, then generating video asset…"
        : "Reviewing prompt, then generating image asset…"
    );
    try {
      const res = await fetch("/api/generate-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: assetProvider,
          kind: assetKind,
          prompt: assetPrompt,
          description: assetDesc || assetPrompt,
          size:
            assetKind === "video" && assetSize === DEFAULT_IMAGE_SIZE
              ? DEFAULT_VIDEO_SIZE
              : assetSize,
          seconds: assetSeconds,
          durationSec: assetKind === "image" ? 4 : assetSeconds,
          referenceClipIds,
          characterProfileIds,
          consistencyMode,
          shotDelta: shotDeltaPrompt.trim()
            ? { prompt: shotDeltaPrompt.trim() }
            : undefined,
          preflightReviewIterations,
          script: goal,
          storyContext,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Asset generation failed");
      setProject(data.project);
      setAssetPrompt("");
      setAssetDesc("");
      setReferenceClipIds([]);
      setShotDeltaPrompt("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRevise() {
    if (!message.trim()) return;
    setError(null);
    setExportResult(null);
    const msg = message;
    setMessage("");
    setBusy("Revising the cut…");
    try {
      const res = await fetch("/api/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Revision failed");
      setProject(data.project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleExport() {
    setError(null);
    setBusy("Rendering MP4 with Remotion (first run downloads a browser)…");
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedAudioClipId: selectedAudioClipId || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Export failed");
      setExportResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const clipById = Object.fromEntries(clips.map((c) => [c.id, c]));
  const imageClips = clips.filter((c) => (c.kind || "video") === "image");
  const characterProfiles = project?.characterProfiles ?? [];

  function toggleReferenceClip(id: string) {
    setReferenceClipIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function toggleCharacterProfile(id: string) {
    setCharacterProfileIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      if (next.length > 0 && consistencyMode === "prompt_only") {
        setConsistencyMode(defaultConsistencyModeForKind(assetKind));
      }
      return next;
    });
  }

  async function handleRegenerateAsset(clip: Clip, newShotDelta: boolean) {
    const binding = clip.generatedBy?.characterBinding;
    if (!binding) return;
    const nextPrompt = newShotDelta
      ? window.prompt("New shot delta", binding.originalPrompt || clip.description)
      : undefined;
    if (newShotDelta && !nextPrompt?.trim()) return;

    setError(null);
    setBusy("Regenerating with character references...");
    try {
      const res = await fetch("/api/generate-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: clip.generatedBy?.provider || assetProvider,
          kind: clip.kind || "image",
          regenerateFromClipId: clip.id,
          prompt: newShotDelta ? nextPrompt : undefined,
          description: newShotDelta ? nextPrompt : clip.description,
          model: clip.generatedBy?.model,
          size: binding.providerSettings?.aspectRatio,
          seconds: clip.durationSec,
          durationSec: clip.durationSec,
          consistencyMode: binding.consistencyMode,
          characterProfileIds: binding.characterProfileIds,
          characterReferenceIds: binding.referenceIds,
          shotDelta: newShotDelta && nextPrompt ? { prompt: nextPrompt } : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Regeneration failed");
      setProject(data.project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  function setStoryField<K extends keyof StoryContext>(
    key: K,
    value: StoryContext[K]
  ) {
    setStoryContext((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="app">
      {/* LEFT: assets + brief */}
      <div className="col">
        <h1>aividi</h1>
        <p className="sub">AI-native video editor — clips + a goal → an editable cut.</p>

        {error && <div className="error">{error}</div>}
        {busy && <div className="spinner">⏳ {busy}</div>}

        <h2>1 · Upload media</h2>
        <input ref={fileRef} type="file" accept="video/*,image/*" />
        <label>Description (what's in this asset — helps the AI choose)</label>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="e.g. close-up of product, smiling face, city b-roll"
        />
        <div style={{ marginTop: 8 }}>
          <button onClick={handleUpload} disabled={!!busy}>
            Add asset
          </button>
        </div>

        <h2>1b · Generate missing asset</h2>
        <div className="row" style={{ marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Provider</label>
            <select
              value={assetProvider}
              onChange={(e) => setAssetProvider(e.target.value)}
            >
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="nanobanano">NanoBanano</option>
              <option value="mock">Mock</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Kind</label>
            <select
              value={assetKind}
              onChange={(e) => {
                const nextKind = e.target.value as "image" | "video";
                setAssetKind(nextKind);
                setAssetSize(
                  nextKind === "video" ? DEFAULT_VIDEO_SIZE : DEFAULT_IMAGE_SIZE
                );
                if (
                  characterProfileIds.length > 0 &&
                  (consistencyMode === "prompt_only" ||
                    (nextKind === "video" && consistencyMode === "reference_pack"))
                ) {
                  setConsistencyMode(defaultConsistencyModeForKind(nextKind));
                }
              }}
            >
              <option value="image">Image</option>
              <option value="video">Video</option>
            </select>
          </div>
        </div>
        <label>Prompt</label>
        <textarea
          value={assetPrompt}
          onChange={(e) => setAssetPrompt(e.target.value)}
          placeholder="Describe the missing visual, e.g. clean product hero shot on a white clinical desk."
        />
        <label>Library description</label>
        <input
          value={assetDesc}
          onChange={(e) => setAssetDesc(e.target.value)}
          placeholder="e.g. generated product hero shot for CTA"
        />
        <div className="row" style={{ marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Size</label>
            <input
              value={assetSize}
              onChange={(e) => setAssetSize(e.target.value)}
              placeholder={
                assetKind === "video" ? DEFAULT_VIDEO_SIZE : DEFAULT_IMAGE_SIZE
              }
            />
          </div>
          {assetKind === "video" && (
            <div style={{ flex: 1 }}>
              <label>Seconds</label>
              <input
                type="number"
                value={assetSeconds}
                onChange={(e) => setAssetSeconds(Number(e.target.value))}
              />
            </div>
          )}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>AI review passes</label>
            <input
              type="number"
              min={0}
              max={3}
              value={preflightReviewIterations}
              onChange={(e) =>
                setPreflightReviewIterations(Number(e.target.value))
              }
            />
          </div>
        </div>
        {imageClips.length > 0 && (
          <div>
            <label>Reference images</label>
            <div className="reference-list">
              {imageClips.map((c) => (
                <label className="check-row" key={c.id}>
                  <input
                    type="checkbox"
                    checked={referenceClipIds.includes(c.id)}
                    onChange={() => toggleReferenceClip(c.id)}
                  />
                  <span>{c.filename}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {characterProfiles.length > 0 && (
          <div>
            <label>Characters</label>
            <div className="reference-list">
              {characterProfiles
                .filter((profile) => profile.status !== "archived")
                .map((profile) => (
                  <label className="check-row" key={profile.id}>
                    <input
                      type="checkbox"
                      checked={characterProfileIds.includes(profile.id)}
                      onChange={() => toggleCharacterProfile(profile.id)}
                    />
                    <span>{profile.name}</span>
                  </label>
                ))}
            </div>
            <label>Consistency mode</label>
            <select
              value={consistencyMode}
              onChange={(e) => setConsistencyMode(e.target.value)}
            >
              <option value="prompt_only">Prompt only</option>
              <option value="reference_pack">Reference pack</option>
              <option value="hero_frame">Hero frame</option>
              <option value="first_frame_video">First frame video</option>
            </select>
            <label>Shot delta</label>
            <input
              value={shotDeltaPrompt}
              onChange={(e) => setShotDeltaPrompt(e.target.value)}
              placeholder="Optional per-shot change while preserving identity"
            />
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <button
            onClick={handleGenerateAsset}
            disabled={!!busy || !assetPrompt.trim()}
            className="secondary"
          >
            Generate asset
          </button>
        </div>

        <h2>Library ({clips.length})</h2>
        {clips.length === 0 && (
          <p className="muted">No clips yet. Upload a few to get started.</p>
        )}
        {clips.map((c: Clip) => (
          <div className="card clip" key={c.id}>
            {(c.kind || "video") === "image" ? (
              <img src={c.url} alt="" />
            ) : (
              <video src={c.url} muted preload="metadata" />
            )}
            <div className="meta">
              <div className="fn">{c.filename}</div>
              <div className="muted">
                {c.kind || "video"} · {c.source || "upload"} ·{" "}
                {c.durationSec.toFixed(1)}s
              </div>
              <div className="muted">{c.description || "no description"}</div>
              {c.generatedBy && (
                <>
                  <div className="muted">
                    {c.generatedBy.provider}
                    {c.generatedBy.model ? ` · ${c.generatedBy.model}` : ""}
                    {c.generatedBy.preflight
                      ? ` · ${c.generatedBy.preflight.completedIterations} AI review pass${
                          c.generatedBy.preflight.completedIterations === 1
                            ? ""
                            : "es"
                        }`
                      : ""}
                  </div>
                  {c.generatedBy.preflight?.passes[0] && (
                    <div className="muted">
                      Preflight: {c.generatedBy.preflight.passes[0].summary}
                    </div>
                  )}
                </>
              )}
              {c.generatedBy?.characterBinding && (
                <>
                  <div className="muted">
                    Characters:{" "}
                    {c.generatedBy.characterBinding.characterProfileIds.join(", ")}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="secondary"
                      onClick={() => handleRegenerateAsset(c, false)}
                      disabled={!!busy}
                    >
                      Regenerate same character
                    </button>
                    <button
                      className="secondary"
                      onClick={() => handleRegenerateAsset(c, true)}
                      disabled={!!busy}
                    >
                      New shot delta
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        ))}

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
                setStoryField(
                  "platform",
                  e.target.value as StoryContext["platform"]
                )
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
        <div style={{ marginTop: 10 }}>
          <button
            onClick={handleGenerate}
            disabled={!!busy || clips.length === 0 || !goal.trim()}
          >
            Generate rough cut
          </button>
        </div>
      </div>

      {/* CENTER: preview + export */}
      <div className="col center">
        <h2 style={{ alignSelf: "flex-start" }}>Preview</h2>
        <Preview timeline={timeline} clips={clips} />
        {timeline && timeline.segments.length > 0 && (
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <div className="muted" style={{ marginBottom: 8 }}>
              {timeline.segments.length} segments ·{" "}
              {timelineDurationSec(timeline).toFixed(1)}s · {timeline.aspectRatio}
            </div>
            {audioClips.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <label style={{ textAlign: "left" }}>Audio overlay</label>
                <select
                  value={selectedAudioClipId}
                  onChange={(e) => setSelectedAudioClipId(e.target.value)}
                >
                  <option value="">None</option>
                  {audioClips.map((clip) => (
                    <option key={clip.id} value={clip.id}>
                      {clip.filename}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button className="secondary" onClick={handleExport} disabled={!!busy}>
              Export MP4
            </button>
            {exportResult && (
              <div style={{ marginTop: 10 }}>
                <a href={exportResult.url} target="_blank" rel="noreferrer">
                  Download render
                </a>
                {exportResult.overlayUrl && exportResult.silentUrl && (
                  <div className="muted" style={{ marginTop: 8 }}>
                    <a
                      href={exportResult.silentUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Silent video
                    </a>
                    {" · "}
                    <a
                      href={exportResult.overlayUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Video + audio overlay
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {project?.plan && (
          <div style={{ alignSelf: "stretch", marginTop: 20 }}>
            <h2>Edit plan</h2>
            <div className="muted" style={{ marginBottom: 6 }}>
              {project.plan.style} · {project.plan.targetLengthSec}s
            </div>
            {project.plan.beats.map((b, i) => (
              <span className="pill" key={i}>
                {b.name} ~{b.durationSec}s
              </span>
            ))}
          </div>
        )}
      </div>

      {/* RIGHT: timeline, critic, chat */}
      <div className="col">
        <h2>Timeline</h2>
        {!timeline && <p className="muted">Generate a cut to see the timeline.</p>}
        {timeline &&
          timeline.segments.map((s, i) => (
            <div className="segment" key={s.id}>
              <span className="idx">{i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div>
                  <b>{s.role}</b> ·{" "}
                  {clipById[s.clipId]?.filename || s.clipId} ·{" "}
                  {segmentDurationSec(s).toFixed(1)}s
                </div>
                <div className="muted">
                  in {s.sourceInSec.toFixed(1)}s → out {s.sourceOutSec.toFixed(1)}s
                </div>
                {s.reason && <div className="muted">{s.reason}</div>}
              </div>
            </div>
          ))}

        {project?.critic && (
          <>
            <h2>Critic</h2>
            <div className="scores">
              {Object.entries(project.critic.scores).map(([k, v]) => (
                <div className="score" key={k}>
                  <span className="muted">{k.replace(/_/g, " ")}</span>
                  <b>{v}</b>
                </div>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              {project.critic.summary}
            </p>
          </>
        )}

        <h2>Revise (chat)</h2>
        <div className="chat">
          {(project?.chat ?? []).length === 0 && (
            <p className="muted">
              Ask for changes: “make it punchier”, “use less talking head”, “shorten
              to 15s”, “add captions”.
            </p>
          )}
          {(project?.chat ?? []).map((m, i) => (
            <div className={`msg ${m.role}`} key={i}>
              {m.content}
            </div>
          ))}
        </div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Make the hook punchier and add captions…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleRevise();
          }}
        />
        <div style={{ marginTop: 8 }}>
          <button onClick={handleRevise} disabled={!!busy || !timeline}>
            Send revision
          </button>
        </div>
      </div>
    </div>
  );
}
