"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  AspectRatio,
  CharacterConsistencyGrade,
  CharacterConsistencyReview,
  CharacterProfile,
  CharacterReference,
  CharacterReferenceQuality,
  CharacterReferenceRole,
  Clip,
  Project,
  StoryContext,
  Timeline,
  segmentDurationSec,
  timelineDurationSec,
} from "@/lib/types";
import { DEFAULT_STORY_CONTEXT } from "@/lib/story-context";
import {
  DEFAULT_DURATION_POLICY,
  DURATION_POLICIES,
  DurationPolicy,
} from "@/lib/audio-alignment";

// Player relies on browser APIs — never SSR it.
const Preview = dynamic(() => import("./Preview"), { ssr: false });
const DEFAULT_IMAGE_SIZE = "1024x1536";
const DEFAULT_VIDEO_SIZE = "720x1280";
const CHARACTER_REFERENCE_ROLES: CharacterReferenceRole[] = [
  "front_portrait",
  "three_quarter",
  "profile",
  "full_body",
  "style",
  "wardrobe",
  "hero_frame",
];
const CHARACTER_REFERENCE_QUALITIES: CharacterReferenceQuality[] = [
  "candidate",
  "approved",
  "rejected",
];
const REVIEW_STATUSES: CharacterConsistencyGrade[] = [
  "needs_review",
  "pass",
  "fail",
];

function titleize(value: string): string {
  return value.replace(/_/g, " ");
}

function emptyCharacterForm() {
  return {
    name: "",
    description: "",
    identityInvariants: "",
    styleInvariants: "",
    wardrobeInvariants: "",
    negativePrompt: "",
  };
}

function defaultConsistencyModeForKind(kind: "image" | "video") {
  return kind === "video" ? "hero_frame" : "reference_pack";
}

interface ExportAlignment {
  policy: DurationPolicy;
  exportDurationSec: number;
  truncatesAudio: boolean;
  warning?: string;
  comparison: {
    timelineDurationSec: number;
    audioDurationSec: number;
    deltaSec: number;
  };
}

interface ExportResult {
  url: string;
  silentUrl?: string;
  overlayUrl?: string | null;
  audioUrls?: string[];
  alignment?: ExportAlignment;
}

const DURATION_POLICY_LABELS: Record<DurationPolicy, string> = {
  timeline_only: "Timeline only (may cut audio)",
  match_longest_media: "Match longest media (keep audio whole)",
  fail_on_mismatch: "Fail on mismatch (require alignment)",
};

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
  const [selectedCharacterReferenceIds, setSelectedCharacterReferenceIds] =
    useState<string[]>([]);
  const [consistencyMode, setConsistencyMode] = useState("prompt_only");
  const [shotDeltaPrompt, setShotDeltaPrompt] = useState("");

  // character workflow
  const [activeCharacterId, setActiveCharacterId] = useState("");
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(
    null
  );
  const [characterForm, setCharacterForm] = useState(emptyCharacterForm());
  const [referenceAssetId, setReferenceAssetId] = useState("");
  const [referenceRole, setReferenceRole] =
    useState<CharacterReferenceRole>("front_portrait");
  const [referenceQuality, setReferenceQuality] =
    useState<CharacterReferenceQuality>("candidate");
  const [referenceNotes, setReferenceNotes] = useState("");

  // chat
  const [message, setMessage] = useState("");
  const [selectedAudioClipId, setSelectedAudioClipId] = useState("");
  const [durationPolicy, setDurationPolicy] = useState<DurationPolicy>(
    DEFAULT_DURATION_POLICY
  );

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
  const characters = project?.characterProfiles ?? [];
  const visibleCharacters = characters.filter((c) => c.status !== "archived");
  const characterReferences = project?.characterReferences ?? [];
  const activeCharacter =
    characters.find((character) => character.id === activeCharacterId) ||
    visibleCharacters[0] ||
    null;
  const activeCharacterReferences = activeCharacter
    ? characterReferences.filter(
        (reference) => reference.characterProfileId === activeCharacter.id
      )
    : [];

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
          characterReferenceIds: selectedCharacterReferenceIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Asset generation failed");
      setProject(data.project);
      setAssetPrompt("");
      setAssetDesc("");
      setReferenceClipIds([]);
      setShotDeltaPrompt("");
      setSelectedCharacterReferenceIds([]);
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
          audioAssetIds: selectedAudioClipId ? [selectedAudioClipId] : [],
          durationPolicy,
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

  async function handleAlignAudio(
    strategy: "rewrite_script" | "extend_timeline"
  ) {
    if (!selectedAudioClipId) {
      setError("Select an audio overlay to align.");
      return;
    }
    setError(null);
    setBusy(
      strategy === "rewrite_script"
        ? "Rewriting narration to fit the timeline…"
        : "Extending the timeline to fit the narration…"
    );
    try {
      const res = await fetch("/api/align-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy, audioClipId: selectedAudioClipId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Alignment failed");
      if (data.project) setProject(data.project);
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
      const allowedReferenceIds = characterReferences
        .filter((reference) => next.includes(reference.characterProfileId))
        .map((reference) => reference.id);
      setSelectedCharacterReferenceIds((refs) =>
        refs.filter((referenceId) => allowedReferenceIds.includes(referenceId))
      );
      if (next.length > 0 && consistencyMode === "prompt_only") {
        setConsistencyMode(defaultConsistencyModeForKind(assetKind));
      }
      return next;
    });
  }

  function toggleSelectedCharacterReference(id: string) {
    setSelectedCharacterReferenceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function editCharacter(character: CharacterProfile) {
    setEditingCharacterId(character.id);
    setActiveCharacterId(character.id);
    setCharacterForm({
      name: character.name,
      description: character.description,
      identityInvariants: character.identityInvariants,
      styleInvariants: character.styleInvariants || "",
      wardrobeInvariants: character.wardrobeInvariants || "",
      negativePrompt: character.negativePrompt || "",
    });
  }

  async function saveCharacter() {
    setError(null);
    setBusy(editingCharacterId ? "Updating character..." : "Creating character...");
    try {
      const res = await fetch(
        editingCharacterId
          ? `/api/characters/${editingCharacterId}`
          : "/api/characters",
        {
          method: editingCharacterId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(characterForm),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to save character");
      setProject(data.project);
      const saved = data.character || data.project.characterProfiles?.find(
        (character: CharacterProfile) => character.name === characterForm.name
      );
      if (saved) setActiveCharacterId(saved.id);
      setEditingCharacterId(null);
      setCharacterForm(emptyCharacterForm());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function archiveCharacter(id: string) {
    setError(null);
    setBusy("Archiving character...");
    try {
      const res = await fetch(`/api/characters/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to archive character");
      setProject(data.project);
      setCharacterProfileIds((prev) => prev.filter((candidate) => candidate !== id));
      if (activeCharacterId === id) setActiveCharacterId("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function saveReference(reference?: CharacterReference) {
    const characterId = reference?.characterProfileId || activeCharacter?.id;
    const assetId = reference?.assetId || referenceAssetId;
    if (!characterId || !assetId) return;
    setError(null);
    setBusy(reference ? "Updating reference..." : "Adding reference...");
    try {
      const res = await fetch(
        reference
          ? `/api/characters/${characterId}/references/${reference.id}`
          : `/api/characters/${characterId}/references`,
        {
          method: reference ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assetId,
            role: reference?.role || referenceRole,
            quality: reference?.quality || referenceQuality,
            notes: reference?.notes || referenceNotes,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to save reference");
      setProject(data.project);
      setReferenceNotes("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function deleteReference(reference: CharacterReference) {
    setError(null);
    setBusy("Removing reference...");
    try {
      const res = await fetch(
        `/api/characters/${reference.characterProfileId}/references/${reference.id}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to remove reference");
      setProject(data.project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function patchReference(
    reference: CharacterReference,
    patch: Partial<CharacterReference>
  ) {
    await saveReference({ ...reference, ...patch });
  }

  async function addReferenceForAsset(
    characterId: string,
    assetId: string,
    role: CharacterReferenceRole,
    quality: CharacterReferenceQuality
  ) {
    setError(null);
    setBusy("Adding reference...");
    try {
      const res = await fetch(`/api/characters/${characterId}/references`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId, role, quality }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to add reference");
      setProject(data.project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function saveReview(
    clip: Clip,
    review: CharacterConsistencyReview
  ) {
    setError(null);
    setBusy("Saving review...");
    try {
      const res = await fetch(`/api/assets/${clip.id}/character-review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(review),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to save review");
      setProject(data.project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
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

        <h2>1a · Characters</h2>
        {visibleCharacters.length > 0 && (
          <div className="character-list">
            {visibleCharacters.map((character) => {
              const refs = characterReferences.filter(
                (reference) => reference.characterProfileId === character.id
              );
              const approvedCount = refs.filter(
                (reference) => reference.quality === "approved"
              ).length;
              return (
                <div
                  className={`character-row ${
                    activeCharacter?.id === character.id ? "active" : ""
                  }`}
                  key={character.id}
                >
                  <button
                    className="secondary compact"
                    onClick={() => setActiveCharacterId(character.id)}
                    disabled={!!busy}
                  >
                    {character.name}
                  </button>
                  <span className={approvedCount >= 3 ? "ready" : "muted"}>
                    {approvedCount >= 3
                      ? "ready"
                      : `needs ${3 - approvedCount} approved`}
                  </span>
                  <button
                    className="secondary compact"
                    onClick={() => editCharacter(character)}
                    disabled={!!busy}
                  >
                    Edit
                  </button>
                  <button
                    className="secondary compact"
                    onClick={() => archiveCharacter(character.id)}
                    disabled={!!busy}
                  >
                    Archive
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <label>{editingCharacterId ? "Edit character" : "New character"}</label>
        <input
          value={characterForm.name}
          onChange={(e) =>
            setCharacterForm((prev) => ({ ...prev, name: e.target.value }))
          }
          placeholder="Character name"
        />
        <input
          value={characterForm.description}
          onChange={(e) =>
            setCharacterForm((prev) => ({
              ...prev,
              description: e.target.value,
            }))
          }
          placeholder="Short description"
        />
        <label>Identity invariants</label>
        <textarea
          value={characterForm.identityInvariants}
          onChange={(e) =>
            setCharacterForm((prev) => ({
              ...prev,
              identityInvariants: e.target.value,
            }))
          }
          placeholder="Face shape, age, hair, expression range, key identifiers."
        />
        <label>Wardrobe invariants</label>
        <textarea
          value={characterForm.wardrobeInvariants}
          onChange={(e) =>
            setCharacterForm((prev) => ({
              ...prev,
              wardrobeInvariants: e.target.value,
            }))
          }
          placeholder="Recurring wardrobe, accessories, colors."
        />
        <label>Style invariants</label>
        <textarea
          value={characterForm.styleInvariants}
          onChange={(e) =>
            setCharacterForm((prev) => ({
              ...prev,
              styleInvariants: e.target.value,
            }))
          }
          placeholder="Rendering style, lighting, illustration or realism constraints."
        />
        <label>Negative prompt / avoid list</label>
        <textarea
          value={characterForm.negativePrompt}
          onChange={(e) =>
            setCharacterForm((prev) => ({
              ...prev,
              negativePrompt: e.target.value,
            }))
          }
          placeholder="Features that should not drift or appear."
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="secondary"
            onClick={saveCharacter}
            disabled={
              !!busy ||
              !characterForm.name.trim() ||
              !characterForm.identityInvariants.trim()
            }
          >
            {editingCharacterId ? "Save character" : "Create character"}
          </button>
          {editingCharacterId && (
            <button
              className="secondary"
              onClick={() => {
                setEditingCharacterId(null);
                setCharacterForm(emptyCharacterForm());
              }}
              disabled={!!busy}
            >
              Cancel
            </button>
          )}
        </div>
        {activeCharacter && imageClips.length > 0 && (
          <div className="reference-editor">
            <label>Reference picker for {activeCharacter.name}</label>
            <select
              value={referenceAssetId}
              onChange={(e) => setReferenceAssetId(e.target.value)}
            >
              <option value="">Choose an image asset</option>
              {imageClips.map((clip) => (
                <option value={clip.id} key={clip.id}>
                  {clip.filename}
                </option>
              ))}
            </select>
            <div className="row" style={{ marginTop: 8 }}>
              <select
                value={referenceRole}
                onChange={(e) =>
                  setReferenceRole(e.target.value as CharacterReferenceRole)
                }
              >
                {CHARACTER_REFERENCE_ROLES.map((role) => (
                  <option value={role} key={role}>
                    {titleize(role)}
                  </option>
                ))}
              </select>
              <select
                value={referenceQuality}
                onChange={(e) =>
                  setReferenceQuality(e.target.value as CharacterReferenceQuality)
                }
              >
                {CHARACTER_REFERENCE_QUALITIES.map((quality) => (
                  <option value={quality} key={quality}>
                    {titleize(quality)}
                  </option>
                ))}
              </select>
            </div>
            <input
              value={referenceNotes}
              onChange={(e) => setReferenceNotes(e.target.value)}
              placeholder="Reference notes"
            />
            <div style={{ marginTop: 8 }}>
              <button
                className="secondary"
                onClick={() => saveReference()}
                disabled={!!busy || !referenceAssetId}
              >
                Add reference
              </button>
            </div>
          </div>
        )}
        {activeCharacter && activeCharacterReferences.length > 0 && (
          <div className="reference-list tall">
            {activeCharacterReferences.map((reference) => (
              <div className="reference-row" key={reference.id}>
                <span>{clipById[reference.assetId]?.filename || reference.assetId}</span>
                <select
                  value={reference.role}
                  onChange={(e) =>
                    patchReference(reference, {
                      role: e.target.value as CharacterReferenceRole,
                    })
                  }
                >
                  {CHARACTER_REFERENCE_ROLES.map((role) => (
                    <option value={role} key={role}>
                      {titleize(role)}
                    </option>
                  ))}
                </select>
                <select
                  value={reference.quality}
                  onChange={(e) =>
                    patchReference(reference, {
                      quality: e.target.value as CharacterReferenceQuality,
                    })
                  }
                >
                  {CHARACTER_REFERENCE_QUALITIES.map((quality) => (
                    <option value={quality} key={quality}>
                      {titleize(quality)}
                    </option>
                  ))}
                </select>
                <button
                  className="secondary compact"
                  onClick={() => deleteReference(reference)}
                  disabled={!!busy}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

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
            <label>Characters for this generation</label>
            <div className="reference-list">
              {characterProfiles
                .filter((profile) => profile.status !== "archived")
                .map((profile) => {
                  const approvedCount = characterReferences.filter(
                    (reference) =>
                      reference.characterProfileId === profile.id &&
                      reference.quality === "approved"
                  ).length;
                  return (
                    <label className="check-row" key={profile.id}>
                      <input
                        type="checkbox"
                        checked={characterProfileIds.includes(profile.id)}
                        onChange={() => toggleCharacterProfile(profile.id)}
                      />
                      <span>
                        {profile.name} ·{" "}
                        {approvedCount >= 3
                          ? "ready"
                          : `needs ${3 - approvedCount} approved`}
                      </span>
                    </label>
                  );
                })}
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
        {characterProfileIds.length > 0 && (
          <div>
            <label>Character references for generation</label>
            <div className="reference-list">
              {characterReferences
                .filter((reference) =>
                  characterProfileIds.includes(reference.characterProfileId)
                )
                .map((reference) => (
                  <label className="check-row" key={reference.id}>
                    <input
                      type="checkbox"
                      checked={selectedCharacterReferenceIds.includes(reference.id)}
                      onChange={() => toggleSelectedCharacterReference(reference.id)}
                      disabled={reference.quality === "rejected"}
                    />
                    <span>
                      {clipById[reference.assetId]?.filename || reference.assetId} ·{" "}
                      {titleize(reference.role)} · {titleize(reference.quality)}
                    </span>
                  </label>
                ))}
              {characterProfileIds.length > 0 &&
                selectedCharacterReferenceIds.length === 0 && (
                  <p className="muted">
                    Approved references will be recorded automatically.
                  </p>
                )}
            </div>
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
              {(c.generatedBy?.characterBinding || c.characterBinding) && (
                <>
                  <div className="muted">
                    Characters: {(
                      c.generatedBy?.characterBinding?.characterProfileIds ||
                      c.characterBinding?.characterProfileIds ||
                      []
                    ).join(", ")}
                    {(c.generatedBy?.characterBinding || c.characterBinding)?.referenceIds.length
                      ? ` · ${(c.generatedBy?.characterBinding || c.characterBinding)?.referenceIds.length} refs`
                      : ""}
                  </div>
                  {c.generatedBy?.characterBinding && (
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
                  )}
                </>
              )}
              {(c.kind || "video") === "image" && activeCharacter && (
                <div className="asset-actions">
                  <button
                    className="secondary compact"
                    onClick={() =>
                      addReferenceForAsset(
                        activeCharacter.id,
                        c.id,
                        c.source === "generated" ? "hero_frame" : referenceRole,
                        c.source === "generated" ? "approved" : "candidate"
                      )
                    }
                    disabled={
                      !!busy ||
                      Boolean(
                        (c.generatedBy?.characterBinding || c.characterBinding)
                          ?.consistencyReview &&
                          Object.values(
                            (c.generatedBy?.characterBinding || c.characterBinding)!
                              .consistencyReview!
                          ).includes("fail")
                      )
                    }
                  >
                    {c.source === "generated"
                      ? "Promote to hero/reference"
                      : "Use as character reference"}
                  </button>
                </div>
              )}
              {(c.generatedBy?.characterBinding || c.characterBinding)
                ?.consistencyReview && (
                <div className="review-grid">
                  {(["identity", "wardrobe", "style", "temporal"] as const).map(
                    (key) => {
                      if (key === "temporal" && (c.kind || "video") !== "video") {
                        return null;
                      }
                      const review = (c.generatedBy?.characterBinding ||
                        c.characterBinding)!.consistencyReview as CharacterConsistencyReview;
                      return (
                        <label key={key}>
                          {titleize(key)}
                          <select
                            value={review[key] || "needs_review"}
                            onChange={(e) =>
                              saveReview(c, {
                                ...review,
                                [key]: e.target.value as CharacterConsistencyGrade,
                              })
                            }
                          >
                            {REVIEW_STATUSES.map((status) => (
                              <option value={status} key={status}>
                                {titleize(status)}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    }
                  )}
                  <label>
                    Notes
                    <input
                      defaultValue={
                        (c.generatedBy?.characterBinding || c.characterBinding)!
                          .consistencyReview?.notes || ""
                      }
                      onBlur={(e) =>
                        saveReview(c, {
                          ...(c.generatedBy?.characterBinding || c.characterBinding)!
                            .consistencyReview!,
                          notes: e.target.value,
                        })
                      }
                      placeholder="Review notes"
                    />
                  </label>
                </div>
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
            {audioClips.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <label style={{ textAlign: "left" }}>Audio duration policy</label>
                <select
                  value={durationPolicy}
                  onChange={(e) =>
                    setDurationPolicy(e.target.value as DurationPolicy)
                  }
                >
                  {DURATION_POLICIES.map((policy) => (
                    <option key={policy} value={policy}>
                      {DURATION_POLICY_LABELS[policy]}
                    </option>
                  ))}
                </select>
                {selectedAudioClipId && (
                  <div
                    style={{
                      marginTop: 6,
                      display: "flex",
                      gap: 8,
                      justifyContent: "center",
                    }}
                  >
                    <button
                      className="secondary"
                      onClick={() => handleAlignAudio("rewrite_script")}
                      disabled={!!busy}
                    >
                      Align: rewrite narration
                    </button>
                    <button
                      className="secondary"
                      onClick={() => handleAlignAudio("extend_timeline")}
                      disabled={!!busy}
                    >
                      Align: extend timeline
                    </button>
                  </div>
                )}
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
                {exportResult.alignment &&
                  exportResult.alignment.comparison.audioDurationSec > 0 && (
                    <div className="muted" style={{ marginTop: 8 }}>
                      {exportResult.alignment.policy} · export{" "}
                      {exportResult.alignment.exportDurationSec.toFixed(1)}s · audio{" "}
                      {exportResult.alignment.comparison.audioDurationSec.toFixed(1)}s
                      {" · Δ"}
                      {exportResult.alignment.comparison.deltaSec.toFixed(1)}s
                      {exportResult.alignment.warning && (
                        <div style={{ color: "#b45309", marginTop: 4 }}>
                          {exportResult.alignment.warning}
                        </div>
                      )}
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
