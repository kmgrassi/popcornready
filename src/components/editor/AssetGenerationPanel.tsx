import {
  CharacterConsistencyMode,
  CharacterProfile,
  CharacterReference,
  CharacterReferenceRole,
  Clip,
} from "@/lib/types";
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_VIDEO_SIZE,
  titleize,
} from "./constants";

interface AssetGenerationPanelProps {
  assetDesc: string;
  assetKind: "image" | "video";
  assetPrompt: string;
  assetProvider: string;
  assetSeconds: number;
  assetSize: string;
  busy: boolean;
  characterProfileIds: string[];
  characterProfiles: CharacterProfile[];
  characterReferences: CharacterReference[];
  clipById: Record<string, Clip>;
  consistencyMode: CharacterConsistencyMode;
  imageClips: Clip[];
  preflightReviewIterations: number;
  referenceClipIds: string[];
  selectedCharacterReferenceIds: string[];
  shotDeltaPrompt: string;
  setAssetDesc: (value: string) => void;
  setAssetKind: (value: "image" | "video") => void;
  setAssetPrompt: (value: string) => void;
  setAssetProvider: (value: string) => void;
  setAssetSeconds: (value: number) => void;
  setAssetSize: (value: string) => void;
  setConsistencyMode: (value: CharacterConsistencyMode) => void;
  setPreflightReviewIterations: (value: number) => void;
  setShotDeltaPrompt: (value: string) => void;
  toggleCharacterProfile: (id: string) => void;
  toggleReferenceClip: (id: string) => void;
  toggleSelectedCharacterReference: (id: string) => void;
  onGenerateAsset: () => void;
  onKindChange: (nextKind: "image" | "video") => void;
}

export function AssetGenerationPanel({
  assetDesc,
  assetKind,
  assetPrompt,
  assetProvider,
  assetSeconds,
  assetSize,
  busy,
  characterProfileIds,
  characterProfiles,
  characterReferences,
  clipById,
  consistencyMode,
  imageClips,
  preflightReviewIterations,
  referenceClipIds,
  selectedCharacterReferenceIds,
  shotDeltaPrompt,
  setAssetDesc,
  setAssetPrompt,
  setAssetProvider,
  setAssetSeconds,
  setAssetSize,
  setConsistencyMode,
  setPreflightReviewIterations,
  setShotDeltaPrompt,
  toggleCharacterProfile,
  toggleReferenceClip,
  toggleSelectedCharacterReference,
  onGenerateAsset,
  onKindChange,
}: AssetGenerationPanelProps) {
  return (
    <>
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
            onChange={(e) => onKindChange(e.target.value as "image" | "video")}
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
            placeholder={assetKind === "video" ? DEFAULT_VIDEO_SIZE : DEFAULT_IMAGE_SIZE}
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
            onChange={(e) => setPreflightReviewIterations(Number(e.target.value))}
          />
        </div>
      </div>
      {imageClips.length > 0 && (
        <div>
          <label>Reference images</label>
          <div className="reference-list">
            {imageClips.map((clip) => (
              <label className="check-row" key={clip.id}>
                <input
                  type="checkbox"
                  checked={referenceClipIds.includes(clip.id)}
                  onChange={() => toggleReferenceClip(clip.id)}
                />
                <span>{clip.filename}</span>
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
            onChange={(e) =>
              setConsistencyMode(e.target.value as CharacterConsistencyMode)
            }
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
            {selectedCharacterReferenceIds.length === 0 && (
              <p className="muted">
                Approved references will be recorded automatically.
              </p>
            )}
          </div>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <button
          onClick={onGenerateAsset}
          disabled={busy || !assetPrompt.trim()}
          className="secondary"
        >
          Generate asset
        </button>
      </div>
    </>
  );
}
