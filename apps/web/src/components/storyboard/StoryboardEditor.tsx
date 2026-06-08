import { useCallback, useMemo, useState } from "react";
import type { Asset } from "@popcorn/shared/assets/types";
import type { Beat, EditPlan, Scene } from "@popcorn/shared/types";
import { v1Api } from "../../lib/api-client";
import "./storyboard.css";

// Storyboard editing surface (PR6 — Storyboard editing).
//
// Edits a project's EditPlan (Scenes -> Beats): reorder/add/remove beats within
// and across scenes, add/remove/reorder scenes, edit scene + beat fields, and
// regenerate a single beat's sketch tile. Scene/beat ids are kept STABLE across
// every edit so persisted assets/provenance keep referencing the same nodes.

function newId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}_${rand}`;
}

function emptyBeat(): Beat {
  // `intent` must be a non-empty string to pass the plan validator
  // (`parseBeat` -> `requireString(intent)`). Seed a starter the user can edit
  // so adding a beat and saving immediately does not fail validation.
  return { id: newId("beat"), name: "New beat", intent: "New beat", durationSec: 3 };
}

function emptyScene(): Scene {
  return { id: newId("scene"), name: "New scene", beats: [emptyBeat()] };
}

function toEditableScenes(plan: EditPlan): Scene[] {
  if (plan.scenes.length > 0) return plan.scenes;
  return [emptyScene()];
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export interface StoryboardEditorProps {
  projectId: string;
  initialPlan: EditPlan;
  assets?: Asset[];
}

function indexStoryboardTileUrlsByBeat(assets: Asset[]): Map<string, string> {
  const byBeat = new Map<string, string>();
  for (const asset of assets) {
    if (asset.role !== "beat_storyboard") continue;
    const beatId = asset.depicts?.beatId;
    if (!beatId) continue;
    byBeat.set(beatId, asset.media.url);
  }
  return byBeat;
}

export function StoryboardEditor({
  projectId,
  initialPlan,
  assets = [],
}: StoryboardEditorProps) {
  const [scenes, setScenes] = useState<Scene[]>(() =>
    toEditableScenes(initialPlan),
  );
  const [planMeta] = useState(() => ({
    targetLengthSec: initialPlan.targetLengthSec,
    style: initialPlan.style,
    aspectRatio: initialPlan.aspectRatio,
  }));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [regenBeatId, setRegenBeatId] = useState<string | null>(null);
  const tileUrlByBeatId = useMemo(
    () => indexStoryboardTileUrlsByBeat(assets),
    [assets]
  );

  const update = useCallback((next: Scene[]) => {
    setScenes(next);
    setDirty(true);
    setSavedAt(null);
  }, []);

  // --- scene ops ---
  const updateScene = (sceneIdx: number, patch: Partial<Scene>) =>
    update(scenes.map((s, i) => (i === sceneIdx ? { ...s, ...patch } : s)));
  const moveScene = (idx: number, dir: -1 | 1) => update(move(scenes, idx, idx + dir));
  const addScene = () => update([...scenes, emptyScene()]);
  const removeScene = (idx: number) => update(scenes.filter((_, i) => i !== idx));

  // --- beat ops ---
  const updateBeat = (sceneIdx: number, beatIdx: number, patch: Partial<Beat>) =>
    update(
      scenes.map((s, i) =>
        i === sceneIdx
          ? { ...s, beats: s.beats.map((b, j) => (j === beatIdx ? { ...b, ...patch } : b)) }
          : s,
      ),
    );
  const addBeat = (sceneIdx: number) =>
    update(
      scenes.map((s, i) =>
        i === sceneIdx ? { ...s, beats: [...s.beats, emptyBeat()] } : s,
      ),
    );
  const removeBeat = (sceneIdx: number, beatIdx: number) =>
    update(
      scenes.map((s, i) =>
        i === sceneIdx ? { ...s, beats: s.beats.filter((_, j) => j !== beatIdx) } : s,
      ),
    );
  const moveBeatWithin = (sceneIdx: number, beatIdx: number, dir: -1 | 1) =>
    update(
      scenes.map((s, i) =>
        i === sceneIdx ? { ...s, beats: move(s.beats, beatIdx, beatIdx + dir) } : s,
      ),
    );
  // Move a beat across scenes (to the end of the adjacent scene).
  const moveBeatAcross = (sceneIdx: number, beatIdx: number, dir: -1 | 1) => {
    const targetIdx = sceneIdx + dir;
    if (targetIdx < 0 || targetIdx >= scenes.length) return;
    const beat = scenes[sceneIdx].beats[beatIdx];
    update(
      scenes.map((s, i) => {
        if (i === sceneIdx) return { ...s, beats: s.beats.filter((_, j) => j !== beatIdx) };
        if (i === targetIdx) return { ...s, beats: [...s.beats, beat] };
        return s;
      }),
    );
  };

  const totalDuration = useMemo(
    () => scenes.reduce((sum, s) => sum + s.beats.reduce((a, b) => a + (b.durationSec || 0), 0), 0),
    [scenes],
  );

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const plan: EditPlan = {
        ...planMeta,
        scenes,
      };
      await v1Api.updateProjectPlan(projectId, plan);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function regenerate(beatId: string | undefined) {
    if (!beatId || regenBeatId) return;
    setRegenBeatId(beatId);
    setSaveError(null);
    try {
      await v1Api.regenerateBeatTile(projectId, beatId);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegenBeatId(null);
    }
  }

  return (
    <main className="sb-shell">
      <div className="sb-header">
        <div>
          <h1>Storyboard</h1>
          <p className="muted">
            {scenes.length} scene{scenes.length === 1 ? "" : "s"} ·{" "}
            {scenes.reduce((n, s) => n + s.beats.length, 0)} beats · ~{totalDuration}s
          </p>
        </div>
        <div className="sb-actions">
          <span
            className={`sb-status ${
              saveError
                ? "sb-status-error"
                : dirty
                  ? "sb-status-dirty"
                  : savedAt
                    ? "sb-status-saved"
                    : ""
            }`}
          >
            {saveError
              ? saveError
              : saving
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : savedAt
                    ? "Saved"
                    : ""}
          </span>
          <button
            type="button"
            className="sb-btn sb-btn-primary"
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            Save plan
          </button>
        </div>
      </div>

      {scenes.map((scene, sceneIdx) => (
        <section className="sb-scene" key={scene.id}>
          <div className="sb-scene-head">
            <div className="sb-field sb-input-grow">
              <label htmlFor={`name-${scene.id}`}>Scene name</label>
              <input
                id={`name-${scene.id}`}
                className="sb-input sb-input-grow"
                value={scene.name}
                onChange={(e) => updateScene(sceneIdx, { name: e.target.value })}
              />
            </div>
            <div className="sb-field">
              <label htmlFor={`setting-${scene.id}`}>Setting</label>
              <input
                id={`setting-${scene.id}`}
                className="sb-input"
                value={scene.setting ?? ""}
                placeholder="location / time"
                onChange={(e) => updateScene(sceneIdx, { setting: e.target.value })}
              />
            </div>
            <div className="sb-field">
              <label htmlFor={`mood-${scene.id}`}>Mood</label>
              <input
                id={`mood-${scene.id}`}
                className="sb-input"
                value={scene.mood ?? ""}
                placeholder="lighting / tone"
                onChange={(e) => updateScene(sceneIdx, { mood: e.target.value })}
              />
            </div>
            <div className="sb-field">
              <label htmlFor={`chars-${scene.id}`}>Characters</label>
              <input
                id={`chars-${scene.id}`}
                className="sb-input"
                value={(scene.characterIds ?? []).join(", ")}
                placeholder="comma-separated ids"
                onChange={(e) =>
                  updateScene(sceneIdx, {
                    characterIds: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
            <div className="sb-scene-controls">
              <button
                type="button"
                className="sb-btn sb-btn-xs"
                onClick={() => moveScene(sceneIdx, -1)}
                disabled={sceneIdx === 0}
                aria-label="Move scene up"
              >
                ↑
              </button>
              <button
                type="button"
                className="sb-btn sb-btn-xs"
                onClick={() => moveScene(sceneIdx, 1)}
                disabled={sceneIdx === scenes.length - 1}
                aria-label="Move scene down"
              >
                ↓
              </button>
              <button
                type="button"
                className="sb-btn sb-btn-xs sb-btn-danger"
                onClick={() => removeScene(sceneIdx)}
                disabled={scenes.length === 1}
              >
                Remove
              </button>
            </div>
          </div>

          {scene.beats.length === 0 ? (
            <p className="sb-empty">No beats. Add one below.</p>
          ) : (
            <div className="sb-beats">
              {scene.beats.map((beat, beatIdx) => {
                const tileUrl = beat.id ? tileUrlByBeatId.get(beat.id) : undefined;
                return (
                  <div className="sb-beat" key={beat.id ?? beatIdx}>
                    <div className="sb-tile">
                      {tileUrl ? (
                        <img src={tileUrl} alt={`${beat.name} storyboard tile`} />
                      ) : (
                        <span>sketch tile</span>
                      )}
                    </div>
                    <div className="sb-beat-row">
                      <input
                        className="sb-input sb-input-grow"
                        value={beat.name}
                        aria-label="Beat name"
                        onChange={(e) => updateBeat(sceneIdx, beatIdx, { name: e.target.value })}
                      />
                      <input
                        className="sb-input sb-duration"
                        type="number"
                        min={0}
                        step={0.5}
                        value={beat.durationSec}
                        aria-label="Beat duration in seconds"
                        onChange={(e) =>
                          updateBeat(sceneIdx, beatIdx, {
                            durationSec: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </div>
                    <textarea
                      className="sb-textarea"
                      value={beat.intent}
                      placeholder="What happens in this beat"
                      aria-label="Beat intent"
                      onChange={(e) => updateBeat(sceneIdx, beatIdx, { intent: e.target.value })}
                    />
                    <div className="sb-beat-controls">
                      <button
                        type="button"
                        className="sb-btn sb-btn-xs"
                        onClick={() => moveBeatWithin(sceneIdx, beatIdx, -1)}
                        disabled={beatIdx === 0}
                        aria-label="Move beat up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn-xs"
                        onClick={() => moveBeatWithin(sceneIdx, beatIdx, 1)}
                        disabled={beatIdx === scene.beats.length - 1}
                        aria-label="Move beat down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn-xs"
                        onClick={() => moveBeatAcross(sceneIdx, beatIdx, -1)}
                        disabled={sceneIdx === 0}
                        title="Move to previous scene"
                      >
                        ⤺ scene
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn-xs"
                        onClick={() => moveBeatAcross(sceneIdx, beatIdx, 1)}
                        disabled={sceneIdx === scenes.length - 1}
                        title="Move to next scene"
                      >
                        scene ⤻
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn-xs"
                        onClick={() => void regenerate(beat.id)}
                        disabled={!beat.id || regenBeatId === beat.id}
                      >
                        {regenBeatId === beat.id ? "Regenerating…" : "Regenerate tile"}
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn-xs sb-btn-danger"
                        onClick={() => removeBeat(sceneIdx, beatIdx)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="sb-scene-add">
            <button type="button" className="sb-btn sb-btn-xs" onClick={() => addBeat(sceneIdx)}>
              + Add beat
            </button>
          </div>
        </section>
      ))}

      <button type="button" className="sb-btn" onClick={addScene}>
        + Add scene
      </button>
    </main>
  );
}
