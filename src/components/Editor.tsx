"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  AspectRatio,
  Clip,
  Project,
  StoryContext,
} from "@/lib/types";
import { DEFAULT_STORY_CONTEXT } from "@/lib/story-context";
import {
  DEFAULT_DURATION_POLICY,
  DurationPolicy,
} from "@/lib/audio-alignment";
import { AssetGenerationPanel } from "./editor/AssetGenerationPanel";
import { BriefPanel } from "./editor/BriefPanel";
import { CharacterPanel } from "./editor/CharacterPanel";
import { LibraryPanel } from "./editor/LibraryPanel";
import { PreviewPanel } from "./editor/PreviewPanel";
import { SidebarPanel } from "./editor/SidebarPanel";
import { useCharacterLibrary } from "./editor/useCharacterLibrary";
import {
  CreatedVideo,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_VIDEO_SIZE,
  ExportResult,
  defaultConsistencyModeForKind,
} from "./editor/shared";

const Preview = dynamic(() => import("./Preview"), { ssr: false });

async function readDuration(file: File): Promise<number> {
  if (file.type.startsWith("image/")) return 4;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    video.src = url;
  });
}

export function Editor({
  initialGoal = "",
  initialLength = 30,
}: {
  initialGoal?: string;
  initialLength?: number;
} = {}) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [createdVideos, setCreatedVideos] = useState<CreatedVideo[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [loadedVideoThumbs, setLoadedVideoThumbs] = useState<
    Record<string, boolean>
  >({});

  const [goal, setGoal] = useState(initialGoal);
  const [targetLength, setTargetLength] = useState(initialLength);
  const [style, setStyle] = useState("fast-paced social ad");
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [storyContext, setStoryContext] = useState<StoryContext>(
    DEFAULT_STORY_CONTEXT
  );

  const [desc, setDesc] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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

  const [message, setMessage] = useState("");
  const [selectedAudioClipId, setSelectedAudioClipId] = useState("");
  const [editMode, setEditMode] = useState<"asset_driven" | "hybrid">(
    "asset_driven"
  );
  const [selectedEditAssetIds, setSelectedEditAssetIds] = useState<string[]>([]);
  const [durationPolicy, setDurationPolicy] = useState<DurationPolicy>(
    DEFAULT_DURATION_POLICY
  );

  const {
    activeCharacter,
    activeCharacterId,
    activeCharacterReferences,
    characterForm,
    characterProfiles,
    characterReferences,
    editingCharacterId,
    referenceAssetId,
    referenceNotes,
    referenceQuality,
    referenceRole,
    visibleCharacters,
    setActiveCharacterId,
    setCharacterForm,
    setEditingCharacterId,
    setReferenceAssetId,
    setReferenceNotes,
    setReferenceQuality,
    setReferenceRole,
    addReferenceForAsset,
    archiveCharacter,
    deleteReference,
    editCharacter,
    handleRegenerateAsset,
    patchReference,
    saveCharacter,
    saveReference,
    saveReview,
  } = useCharacterLibrary({
    assetProvider,
    project,
    setBusy,
    setError,
    setProject,
    setCharacterProfileIds,
  });

  useEffect(() => {
    fetch("/api/project")
      .then((response) => response.json())
      .then((data) => {
        setProject(data.project);
        if (data.project?.storyContext) setStoryContext(data.project.storyContext);
      })
      .catch((fetchError) => setError(String(fetchError)));
  }, []);

  async function refreshCreatedVideos() {
    setGalleryLoading(true);
    try {
      const response = await fetch("/api/exports");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load videos");
      setCreatedVideos(data.videos || []);
      setLoadedVideoThumbs({});
    } catch (refreshError: any) {
      setError(refreshError.message);
    } finally {
      setGalleryLoading(false);
    }
  }

  useEffect(() => {
    void refreshCreatedVideos();
  }, []);

  const clips = project?.clips ?? [];
  const timeline = project?.timeline ?? null;
  const audioClips = useMemo(
    () => clips.filter((clip) => clip.kind === "audio"),
    [clips]
  );
  const editableVisualClips = useMemo(
    () => clips.filter((clip) => (clip.kind || "video") !== "audio"),
    [clips]
  );
  const clipById = Object.fromEntries(clips.map((clip) => [clip.id, clip]));
  const imageClips = clips.filter((clip) => (clip.kind || "video") === "image");

  useEffect(() => {
    setSelectedAudioClipId((current) => {
      if (current && audioClips.some((clip) => clip.id === current)) {
        return current;
      }
      return audioClips.length === 1 ? audioClips[0].id : "";
    });
  }, [audioClips]);

  useEffect(() => {
    setSelectedEditAssetIds((current) => {
      const availableIds = new Set(editableVisualClips.map((clip) => clip.id));
      const kept = current.filter((id) => availableIds.has(id));
      if (kept.length > 0 || editableVisualClips.length === 0) return kept;
      return editableVisualClips
        .filter((clip) => clip.source !== "generated")
        .map((clip) => clip.id);
    });
  }, [editableVisualClips]);

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    setBusy("Uploading clip…");
    try {
      const durationSec = await readDuration(file);
      const formData = new FormData();
      formData.append("file", file);
      formData.append("durationSec", String(durationSec));
      formData.append("description", desc);
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed");
      setProject(data.project);
      setDesc("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (uploadError: any) {
      setError(uploadError.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleGenerate() {
    setError(null);
    setExportResult(null);
    setBusy("Planning beats, selecting clips, running the critic…");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          targetLengthSec: targetLength,
          style,
          aspectRatio: aspect,
          storyContext,
          mode: editMode,
          assetIds: selectedEditAssetIds,
          allowGeneratedGapFill: editMode === "hybrid",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Generation failed");
      setProject(data.project);
    } catch (generateError: any) {
      setError(generateError.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleOneShot() {
    if (!goal.trim()) return;
    setError(null);
    setExportResult(null);
    setBusy(
      "Creating your video from the prompt — planning, generating a clip for each scene, and cutting. This can take a couple of minutes…"
    );
    try {
      const res = await fetch("/api/oneshot", {
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
      if (!res.ok) throw new Error(data.error || "One-shot generation failed");
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
      const response = await fetch("/api/generate-assets", {
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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Asset generation failed");
      setProject(data.project);
      setAssetPrompt("");
      setAssetDesc("");
      setReferenceClipIds([]);
      setShotDeltaPrompt("");
      setSelectedCharacterReferenceIds([]);
    } catch (assetError: any) {
      setError(assetError.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRevise() {
    if (!message.trim()) return;
    setError(null);
    setExportResult(null);
    const nextMessage = message;
    setMessage("");
    setBusy("Revising the cut…");
    try {
      const response = await fetch("/api/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: nextMessage }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Revision failed");
      setProject(data.project);
    } catch (reviseError: any) {
      setError(reviseError.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleExport() {
    setError(null);
    setBusy("Rendering MP4 with Remotion (first run downloads a browser)…");
    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioAssetIds: selectedAudioClipId ? [selectedAudioClipId] : [],
          durationPolicy,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Export failed");
      setExportResult(data);
      await refreshCreatedVideos();
    } catch (exportError: any) {
      setError(exportError.message);
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
      const response = await fetch("/api/align-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy, audioClipId: selectedAudioClipId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Alignment failed");
      if (data.project) setProject(data.project);
    } catch (alignError: any) {
      setError(alignError.message);
    } finally {
      setBusy(null);
    }
  }

  function toggleReferenceClip(id: string) {
    setReferenceClipIds((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
    );
  }

  function toggleCharacterProfile(id: string) {
    setCharacterProfileIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((value) => value !== id)
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
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
    );
  }

  function toggleEditAsset(id: string) {
    setSelectedEditAssetIds((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
    );
  }

  function setStoryField<K extends keyof StoryContext>(
    key: K,
    value: StoryContext[K]
  ) {
    setStoryContext((prev) => ({ ...prev, [key]: value }));
  }

  function handleAssetKindChange(nextKind: "image" | "video") {
    setAssetKind(nextKind);
    setAssetSize(nextKind === "video" ? DEFAULT_VIDEO_SIZE : DEFAULT_IMAGE_SIZE);
    if (
      characterProfileIds.length > 0 &&
      (consistencyMode === "prompt_only" ||
        (nextKind === "video" && consistencyMode === "reference_pack"))
    ) {
      setConsistencyMode(defaultConsistencyModeForKind(nextKind));
    }
  }

  return (
    <div className="app">
      <div className="col">
        <h1>Popcorn Ready</h1>
        <p className="sub">AI-native video editor — clips + a goal → an editable cut.</p>

        {error && <div className="error">{error}</div>}
        {busy && <div className="spinner">⏳ {busy}</div>}

        <h2>1 · Upload media</h2>
        <input ref={fileRef} type="file" accept="video/*,image/*" />
        <label>Description (what&apos;s in this asset — helps the AI choose)</label>
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

        <CharacterPanel
          activeCharacter={activeCharacter}
          activeCharacterId={activeCharacterId}
          activeCharacterReferences={activeCharacterReferences}
          busy={!!busy}
          characterForm={characterForm}
          characterReferences={characterReferences}
          clipById={clipById}
          editingCharacterId={editingCharacterId}
          imageClips={imageClips}
          referenceAssetId={referenceAssetId}
          referenceNotes={referenceNotes}
          referenceQuality={referenceQuality}
          referenceRole={referenceRole}
          setActiveCharacterId={setActiveCharacterId}
          setCharacterForm={setCharacterForm}
          setEditingCharacterId={setEditingCharacterId}
          setReferenceAssetId={setReferenceAssetId}
          setReferenceNotes={setReferenceNotes}
          setReferenceQuality={setReferenceQuality}
          setReferenceRole={setReferenceRole}
          visibleCharacters={visibleCharacters}
          onArchiveCharacter={archiveCharacter}
          onDeleteReference={deleteReference}
          onEditCharacter={editCharacter}
          onPatchReference={patchReference}
          onSaveCharacter={saveCharacter}
          onSaveReference={() => void saveReference()}
        />

        <AssetGenerationPanel
          assetDesc={assetDesc}
          assetKind={assetKind}
          assetPrompt={assetPrompt}
          assetProvider={assetProvider}
          assetSeconds={assetSeconds}
          assetSize={assetSize}
          busy={!!busy}
          characterProfileIds={characterProfileIds}
          characterProfiles={characterProfiles}
          characterReferences={characterReferences}
          clipById={clipById}
          consistencyMode={consistencyMode}
          imageClips={imageClips}
          preflightReviewIterations={preflightReviewIterations}
          referenceClipIds={referenceClipIds}
          selectedCharacterReferenceIds={selectedCharacterReferenceIds}
          shotDeltaPrompt={shotDeltaPrompt}
          setAssetDesc={setAssetDesc}
          setAssetKind={handleAssetKindChange}
          setAssetPrompt={setAssetPrompt}
          setAssetProvider={setAssetProvider}
          setAssetSeconds={setAssetSeconds}
          setAssetSize={setAssetSize}
          setConsistencyMode={setConsistencyMode}
          setPreflightReviewIterations={setPreflightReviewIterations}
          setShotDeltaPrompt={setShotDeltaPrompt}
          onGenerateAsset={handleGenerateAsset}
          onToggleCharacterProfile={toggleCharacterProfile}
          onToggleReferenceClip={toggleReferenceClip}
          onToggleSelectedCharacterReference={toggleSelectedCharacterReference}
        />

        <LibraryPanel
          activeCharacter={activeCharacter}
          busy={!!busy}
          clips={clips}
          defaultReferenceRole={referenceRole}
          selectedEditAssetIds={selectedEditAssetIds}
          onAddReferenceForAsset={addReferenceForAsset}
          onHandleRegenerateAsset={handleRegenerateAsset}
          onSaveReview={saveReview}
          onToggleEditAsset={toggleEditAsset}
        />

        <BriefPanel
          aspect={aspect}
          busy={!!busy}
          clipsCount={clips.length}
          editMode={editMode}
          goal={goal}
          hasLibraryGeneration={clips.length > 0}
          selectedEditAssetsCount={selectedEditAssetIds.length}
          storyContext={storyContext}
          style={style}
          targetLength={targetLength}
          setAspect={setAspect}
          setEditMode={setEditMode}
          setGoal={setGoal}
          setStyle={setStyle}
          setTargetLength={setTargetLength}
          setStoryField={setStoryField}
          onGenerate={handleGenerate}
          onOneShot={handleOneShot}
        />
      </div>

      <PreviewPanel
        Preview={Preview}
        audioClips={audioClips}
        busy={!!busy}
        durationPolicy={durationPolicy}
        exportResult={exportResult}
        createdVideos={createdVideos}
        galleryLoading={galleryLoading}
        loadedVideoThumbs={loadedVideoThumbs}
        plan={project?.plan ?? undefined}
        selectedAudioClipId={selectedAudioClipId}
        setDurationPolicy={setDurationPolicy}
        setLoadedVideoThumbs={setLoadedVideoThumbs}
        setSelectedAudioClipId={setSelectedAudioClipId}
        timeline={timeline}
        clips={clips}
        onAlignAudio={handleAlignAudio}
        onExport={handleExport}
        onRefreshCreatedVideos={refreshCreatedVideos}
      />

      <SidebarPanel
        busy={!!busy}
        clipById={clipById}
        message={message}
        project={project}
        setMessage={setMessage}
        timeline={timeline}
        onRevise={handleRevise}
      />
    </div>
  );
}
