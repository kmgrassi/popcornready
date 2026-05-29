import {
  CharacterConsistencyGrade,
  CharacterConsistencyReview,
  CharacterProfile,
  CharacterReferenceQuality,
  CharacterReferenceRole,
  Clip,
} from "@/lib/types";
import { REVIEW_STATUSES, titleize } from "./constants";

interface LibraryPanelProps {
  activeCharacter: CharacterProfile | null;
  busy: boolean;
  clips: Clip[];
  onAddReferenceForAsset: (
    characterId: string,
    assetId: string,
    role: CharacterReferenceRole,
    quality: CharacterReferenceQuality
  ) => void;
  onHandleRegenerateAsset: (clip: Clip, newShotDelta: boolean) => void;
  onSaveReview: (clip: Clip, review: CharacterConsistencyReview) => void;
  referenceRole: CharacterReferenceRole;
}

export function LibraryPanel({
  activeCharacter,
  busy,
  clips,
  onAddReferenceForAsset,
  onHandleRegenerateAsset,
  onSaveReview,
  referenceRole,
}: LibraryPanelProps) {
  return (
    <>
      <h2>Library ({clips.length})</h2>
      {clips.length === 0 && (
        <p className="muted">No clips yet. Upload a few to get started.</p>
      )}
      {clips.map((clip) => {
        const binding = clip.generatedBy?.characterBinding || clip.characterBinding;
        const review = binding?.consistencyReview;
        return (
          <div className="card clip" key={clip.id}>
            {(clip.kind || "video") === "image" ? (
              <img src={clip.url} alt="" />
            ) : (
              <video src={clip.url} muted preload="metadata" />
            )}
            <div className="meta">
              <div className="fn">{clip.filename}</div>
              <div className="muted">
                {clip.kind || "video"} · {clip.source || "upload"} ·{" "}
                {clip.durationSec.toFixed(1)}s
              </div>
              <div className="muted">{clip.description || "no description"}</div>
              {clip.generatedBy && (
                <>
                  <div className="muted">
                    {clip.generatedBy.provider}
                    {clip.generatedBy.model ? ` · ${clip.generatedBy.model}` : ""}
                    {clip.generatedBy.preflight
                      ? ` · ${clip.generatedBy.preflight.completedIterations} AI review pass${
                          clip.generatedBy.preflight.completedIterations === 1
                            ? ""
                            : "es"
                        }`
                      : ""}
                  </div>
                  {clip.generatedBy.preflight?.passes[0] && (
                    <div className="muted">
                      Preflight: {clip.generatedBy.preflight.passes[0].summary}
                    </div>
                  )}
                </>
              )}
              {binding && (
                <>
                  <div className="muted">
                    Characters: {binding.characterProfileIds.join(", ")}
                    {binding.referenceIds.length
                      ? ` · ${binding.referenceIds.length} refs`
                      : ""}
                  </div>
                  {clip.generatedBy?.characterBinding && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <button
                        className="secondary"
                        onClick={() => onHandleRegenerateAsset(clip, false)}
                        disabled={busy}
                      >
                        Regenerate same character
                      </button>
                      <button
                        className="secondary"
                        onClick={() => onHandleRegenerateAsset(clip, true)}
                        disabled={busy}
                      >
                        New shot delta
                      </button>
                    </div>
                  )}
                </>
              )}
              {(clip.kind || "video") === "image" && activeCharacter && (
                <div className="asset-actions">
                  <button
                    className="secondary compact"
                    onClick={() =>
                      onAddReferenceForAsset(
                        activeCharacter.id,
                        clip.id,
                        clip.source === "generated" ? "hero_frame" : referenceRole,
                        clip.source === "generated" ? "approved" : "candidate"
                      )
                    }
                    disabled={
                      busy ||
                      Boolean(
                        review && Object.values(review).includes("fail" as CharacterConsistencyGrade)
                      )
                    }
                  >
                    {clip.source === "generated"
                      ? "Promote to hero/reference"
                      : "Use as character reference"}
                  </button>
                </div>
              )}
              {review && (
                <div className="review-grid">
                  {(["identity", "wardrobe", "style", "temporal"] as const).map(
                    (key) => {
                      if (key === "temporal" && (clip.kind || "video") !== "video") {
                        return null;
                      }
                      return (
                        <label key={key}>
                          {titleize(key)}
                          <select
                            value={review[key] || "needs_review"}
                            onChange={(e) =>
                              onSaveReview(clip, {
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
                      defaultValue={review.notes || ""}
                      onBlur={(e) =>
                        onSaveReview(clip, {
                          ...review,
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
        );
      })}
    </>
  );
}
