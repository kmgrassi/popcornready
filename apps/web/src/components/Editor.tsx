"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AspectRatio,
  Clip,
  Project,
  StoryContext,
  UploadedFootageEditMode,
} from "@popcorn/shared/types";
import { DEFAULT_STORY_CONTEXT } from "@popcorn/shared/story-context";
import {
  DEFAULT_DURATION_POLICY,
  DurationPolicy,
} from "@popcorn/shared/audio-alignment";
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
import { PreviewPlayer } from "./PreviewPlayer";
import { v1Api } from "../lib/api-client";

const Preview = PreviewPlayer;
const EMPTY_CLIPS: Clip[] = [];

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
  const [editMode, setEditMode] = useState<UploadedFootageEditMode>(
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
    v1Api
      .getStudioProject()
      .then((data) => {
        setProject(data.project);
        if (data.project?.storyContext) setStoryContext(data.project.storyContext);
      })
      .catch((fetchError) => setError(String(fetchError)));
  }, []);

  async function refreshCreatedVideos() {
    setGalleryLoading(true);
    try {
      const data = await v1Api.listCreatedVideos();
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

  const clips = project?.clips ?? EMPTY_CLIPS;
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
    const savedEdit = project?.uploadedFootageEdit;
    if (savedEdit) {
      const availableIds = new Set(editableVisualClips.map((clip) => clip.id));
      setEditMode(savedEdit.mode);
      setSelectedEditAssetIds(
        savedEdit.selectedAssetIds.filter((id) => availableIds.has(id))
      );
      return;
    }

    setSelectedEditAssetIds((current) => {
      const availableIds = new Set(editableVisualClips.map((clip) => clip.id));
      const kept = current.filter((id) => availableIds.has(id));
      if (kept.length > 0 || editableVisualClips.length === 0) return kept;
      return editableVisualClips
        .filter((clip) => clip.source !== "generated")
        .map((clip) => clip.id);
    });
  }, [editableVisualClips, project?.uploadedFootageEdit]);

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setError("Asset upload is unavailable until the v1 assets route is mounted.");
  }

  async function handleGenerate() {
    setError("Timeline generation is unavailable until the v1 generation route is mounted.");
  }

  async function handleOneShot() {
    if (!goal.trim()) return;
    setError("Prompt-to-video generation is unavailable until the v1 generation route is mounted.");
  }

  async function handleGenerateAsset() {
    if (!assetPrompt.trim()) return;
    setError("Asset generation is unavailable until the v1 generated-assets route is mounted.");
  }

  async function handleRevise() {
    if (!message.trim()) return;
    setError("Timeline revision is unavailable until the v1 revision route is mounted.");
  }

  async function handleExport() {
    setError("Timeline export is unavailable until the v1 export route is mounted.");
  }

  async function handleAlignAudio(
    strategy: "rewrite_script" | "extend_timeline"
  ) {
    if (!selectedAudioClipId) {
      setError("Select an audio overlay to align.");
      return;
    }
    setError("Audio alignment is unavailable until the v1 alignment route is mounted.");
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

        <BriefPanel
          aspect={aspect}
          busy={!!busy}
          clipsCount={clips.length}
          editMode={editMode}
          goal={goal}
          hasLibraryGeneration={false}
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
        showActions={false}
      />

      <SidebarPanel
        busy={!!busy}
        clipById={clipById}
        message={message}
        project={project}
        setMessage={setMessage}
        timeline={timeline}
        onRevise={handleRevise}
        showActions={false}
      />
    </div>
  );
}
