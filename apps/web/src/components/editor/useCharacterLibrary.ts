import { Dispatch, SetStateAction, useMemo, useState } from "react";
import {
  CharacterConsistencyReview,
  CharacterProfile,
  CharacterReference,
  CharacterReferenceQuality,
  CharacterReferenceRole,
  Clip,
  Project,
} from "@popcorn/shared/types";
import {
  CharacterFormState,
  emptyCharacterForm,
} from "./shared";
import { v1Api } from "../../lib/api-client";

type UseCharacterLibraryParams = {
  assetProvider: string;
  project: Project | null;
  setBusy: (value: string | null) => void;
  setError: (value: string | null) => void;
  setProject: (project: Project | null) => void;
  setCharacterProfileIds: Dispatch<SetStateAction<string[]>>;
};

const EMPTY_CHARACTER_PROFILES: CharacterProfile[] = [];
const EMPTY_CHARACTER_REFERENCES: CharacterReference[] = [];

function unsupported(feature: string): never {
  throw new Error(`${feature} is not available in the v1 API yet.`);
}

export function useCharacterLibrary({
  assetProvider,
  project,
  setBusy,
  setError,
  setProject,
  setCharacterProfileIds,
}: UseCharacterLibraryParams) {
  const [activeCharacterId, setActiveCharacterId] = useState("");
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(
    null
  );
  const [characterForm, setCharacterForm] = useState<CharacterFormState>(
    emptyCharacterForm()
  );
  const [referenceAssetId, setReferenceAssetId] = useState("");
  const [referenceRole, setReferenceRole] =
    useState<CharacterReferenceRole>("front_portrait");
  const [referenceQuality, setReferenceQuality] =
    useState<CharacterReferenceQuality>("candidate");
  const [referenceNotes, setReferenceNotes] = useState("");

  const characterProfiles = project?.characterProfiles ?? EMPTY_CHARACTER_PROFILES;
  const characterReferences =
    project?.characterReferences ?? EMPTY_CHARACTER_REFERENCES;
  const visibleCharacters = useMemo(
    () =>
      characterProfiles.filter((character) => character.status !== "archived"),
    [characterProfiles]
  );
  const activeCharacter = useMemo(
    () =>
      characterProfiles.find((character) => character.id === activeCharacterId) ||
      visibleCharacters[0] ||
      null,
    [activeCharacterId, characterProfiles, visibleCharacters]
  );
  const activeCharacterReferences = useMemo(
    () =>
      activeCharacter
        ? characterReferences.filter(
            (reference) => reference.characterProfileId === activeCharacter.id
          )
        : [],
    [activeCharacter, characterReferences]
  );

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
      unsupported("Character editing");
      setEditingCharacterId(null);
      setCharacterForm(emptyCharacterForm());
    } catch (saveError: any) {
      setError(saveError.message);
    } finally {
      setBusy(null);
    }
  }

  async function archiveCharacter(id: string) {
    setError(null);
    setBusy("Archiving character...");
    try {
      unsupported("Character archiving");
      setCharacterProfileIds((prev) =>
        prev.filter((candidate) => candidate !== id)
      );
      if (activeCharacterId === id) setActiveCharacterId("");
    } catch (archiveError: any) {
      setError(archiveError.message);
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
      void characterId;
      void assetId;
      unsupported("Character references");
      setReferenceNotes("");
    } catch (referenceError: any) {
      setError(referenceError.message);
    } finally {
      setBusy(null);
    }
  }

  async function deleteReference(reference: CharacterReference) {
    setError(null);
    setBusy("Removing reference...");
    try {
      void reference;
      unsupported("Character references");
    } catch (deleteError: any) {
      setError(deleteError.message);
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
      void characterId;
      void assetId;
      void role;
      void quality;
      unsupported("Character references");
    } catch (addReferenceError: any) {
      setError(addReferenceError.message);
    } finally {
      setBusy(null);
    }
  }

  async function saveReview(clip: Clip, review: CharacterConsistencyReview) {
    setError(null);
    setBusy("Saving review...");
    try {
      void clip;
      void review;
      unsupported("Character review");
    } catch (reviewError: any) {
      setError(reviewError.message);
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
      const data = await v1Api.generateAsset({
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
      });
      setProject(data.project);
    } catch (regenerateError: any) {
      setError(regenerateError.message);
    } finally {
      setBusy(null);
    }
  }

  return {
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
  };
}
