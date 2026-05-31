import React from "react";
import {
  CharacterProfile,
  CharacterReference,
  CharacterReferenceQuality,
  CharacterReferenceRole,
  Clip,
} from "@/lib/types";
import {
  CHARACTER_REFERENCE_QUALITIES,
  CHARACTER_REFERENCE_ROLES,
  CharacterFormState,
  emptyCharacterForm,
  titleize,
} from "./shared";

interface CharacterPanelProps {
  activeCharacter: CharacterProfile | null;
  activeCharacterId: string;
  activeCharacterReferences: CharacterReference[];
  busy: boolean;
  characterForm: CharacterFormState;
  characterReferences: CharacterReference[];
  clipById: Record<string, Clip>;
  editingCharacterId: string | null;
  imageClips: Clip[];
  referenceAssetId: string;
  referenceNotes: string;
  referenceQuality: CharacterReferenceQuality;
  referenceRole: CharacterReferenceRole;
  setActiveCharacterId: (value: string) => void;
  setCharacterForm: React.Dispatch<React.SetStateAction<CharacterFormState>>;
  setEditingCharacterId: (value: string | null) => void;
  setReferenceAssetId: (value: string) => void;
  setReferenceNotes: (value: string) => void;
  setReferenceQuality: (value: CharacterReferenceQuality) => void;
  setReferenceRole: (value: CharacterReferenceRole) => void;
  visibleCharacters: CharacterProfile[];
  onArchiveCharacter: (id: string) => void;
  onDeleteReference: (reference: CharacterReference) => void;
  onEditCharacter: (character: CharacterProfile) => void;
  onPatchReference: (
    reference: CharacterReference,
    patch: Partial<CharacterReference>
  ) => void;
  onSaveCharacter: () => void;
  onSaveReference: () => void;
}

export function CharacterPanel({
  activeCharacter,
  activeCharacterId,
  activeCharacterReferences,
  busy,
  characterForm,
  characterReferences,
  clipById,
  editingCharacterId,
  imageClips,
  referenceAssetId,
  referenceNotes,
  referenceQuality,
  referenceRole,
  setActiveCharacterId,
  setCharacterForm,
  setEditingCharacterId,
  setReferenceAssetId,
  setReferenceNotes,
  setReferenceQuality,
  setReferenceRole,
  visibleCharacters,
  onArchiveCharacter,
  onDeleteReference,
  onEditCharacter,
  onPatchReference,
  onSaveCharacter,
  onSaveReference,
}: CharacterPanelProps) {
  return (
    <>
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
                  disabled={busy}
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
                  onClick={() => onEditCharacter(character)}
                  disabled={busy}
                >
                  Edit
                </button>
                <button
                  className="secondary compact"
                  onClick={() => onArchiveCharacter(character.id)}
                  disabled={busy}
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
          onClick={onSaveCharacter}
          disabled={
            busy ||
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
            disabled={busy}
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
              onClick={onSaveReference}
              disabled={busy || !referenceAssetId}
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
                  onPatchReference(reference, {
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
                  onPatchReference(reference, {
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
                onClick={() => onDeleteReference(reference)}
                disabled={busy}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
