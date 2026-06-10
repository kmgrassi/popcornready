import { useCallback, useMemo, useState } from "react";
import type {
  ProjectStoryboard,
  StoryboardBeat,
  StoryboardScene,
} from "@popcorn/shared/v1/types";
import { v1Api } from "../../lib/api-client";
import "./storyboard.css";

type EditableBeat = Pick<
  StoryboardBeat,
  | "id"
  | "intent"
  | "visualDescription"
  | "dialogueSummary"
  | "narration"
  | "durationSec"
  | "status"
>;

type EditableScene = Pick<
  StoryboardScene,
  | "id"
  | "title"
  | "summary"
  | "setting"
  | "mood"
  | "durationSec"
  | "status"
> & {
  beats: EditableBeat[];
};

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function emptyBeat(): EditableBeat {
  return {
    id: newId(),
    intent: "New beat",
    visualDescription: null,
    dialogueSummary: null,
    narration: null,
    durationSec: 3,
    status: "draft",
  };
}

function emptyScene(): EditableScene {
  return {
    id: newId(),
    title: "New scene",
    summary: null,
    setting: null,
    mood: null,
    durationSec: null,
    status: "draft",
    beats: [emptyBeat()],
  };
}

function toEditableScenes(storyboard: ProjectStoryboard | null): EditableScene[] {
  if (!storyboard || storyboard.scenes.length === 0) return [emptyScene()];
  return storyboard.scenes.map((scene) => ({
    id: scene.id,
    title: scene.title,
    summary: scene.summary,
    setting: scene.setting,
    mood: scene.mood,
    durationSec: scene.durationSec,
    status: scene.status,
    beats:
      scene.beats.length > 0
        ? scene.beats.map((beat) => ({
            id: beat.id,
            intent: beat.intent,
            visualDescription: beat.visualDescription,
            dialogueSummary: beat.dialogueSummary,
            narration: beat.narration,
            durationSec: beat.durationSec,
            status: beat.status,
          }))
        : [emptyBeat()],
  }));
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
  initialStoryboard: ProjectStoryboard | null;
}

export function StoryboardEditor({
  projectId,
  initialStoryboard,
}: StoryboardEditorProps) {
  const [storyboardId, setStoryboardId] = useState<string | null>(
    initialStoryboard?.id ?? null
  );
  const [status, setStatus] = useState<ProjectStoryboard["status"]>(
    initialStoryboard?.status ?? "draft"
  );
  const [scenes, setScenes] = useState<EditableScene[]>(() =>
    toEditableScenes(initialStoryboard)
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const update = useCallback((next: EditableScene[]) => {
    setScenes(next);
    setDirty(true);
    setSavedAt(null);
  }, []);

  const updateScene = (sceneIdx: number, patch: Partial<EditableScene>) =>
    update(scenes.map((s, i) => (i === sceneIdx ? { ...s, ...patch } : s)));
  const moveScene = (idx: number, dir: -1 | 1) => update(move(scenes, idx, idx + dir));
  const addScene = () => update([...scenes, emptyScene()]);
  const removeScene = (idx: number) => update(scenes.filter((_, i) => i !== idx));

  const updateBeat = (sceneIdx: number, beatIdx: number, patch: Partial<EditableBeat>) =>
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
      const result = await v1Api.saveProjectStoryboard(projectId, {
        id: storyboardId ?? "",
        status,
        scenes: scenes.map((scene) => ({
          ...scene,
          title: scene.title || "Untitled scene",
          beats: scene.beats.map((beat) => ({
            ...beat,
            intent: beat.intent || "Untitled beat",
          })),
        })),
      });
      setStoryboardId(result.storyboard.id);
      setStatus(result.storyboard.status);
      setScenes(toEditableScenes(result.storyboard));
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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
                ? "Saving..."
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
            Save storyboard
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
                value={scene.title ?? ""}
                onChange={(e) => updateScene(sceneIdx, { title: e.target.value })}
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
                className="sb-btn sb-btn-danger sb-btn-xs"
                onClick={() => removeScene(sceneIdx)}
                disabled={scenes.length === 1}
              >
                Remove scene
              </button>
            </div>
          </div>

          <div className="sb-beats">
            {scene.beats.map((beat, beatIdx) => (
              <article className="sb-beat" key={beat.id}>
                <div className="sb-beat-media">
                  <div className="sb-thumb-placeholder">Storyboard panel</div>
                </div>
                <div className="sb-beat-fields">
                  <div className="sb-beat-row">
                    <div className="sb-field sb-input-grow">
                      <label htmlFor={`intent-${beat.id}`}>Intent</label>
                      <input
                        id={`intent-${beat.id}`}
                        className="sb-input sb-input-grow"
                        value={beat.intent}
                        onChange={(e) =>
                          updateBeat(sceneIdx, beatIdx, { intent: e.target.value })
                        }
                      />
                    </div>
                    <div className="sb-field sb-duration">
                      <label htmlFor={`duration-${beat.id}`}>Seconds</label>
                      <input
                        id={`duration-${beat.id}`}
                        className="sb-input"
                        type="number"
                        min="0"
                        step="0.5"
                        value={beat.durationSec ?? ""}
                        onChange={(e) =>
                          updateBeat(sceneIdx, beatIdx, {
                            durationSec: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="sb-field">
                    <label htmlFor={`visual-${beat.id}`}>Visual description</label>
                    <textarea
                      id={`visual-${beat.id}`}
                      className="sb-textarea"
                      value={beat.visualDescription ?? ""}
                      onChange={(e) =>
                        updateBeat(sceneIdx, beatIdx, {
                          visualDescription: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="sb-field">
                    <label htmlFor={`dialogue-${beat.id}`}>Dialogue summary</label>
                    <textarea
                      id={`dialogue-${beat.id}`}
                      className="sb-textarea"
                      value={beat.dialogueSummary ?? ""}
                      onChange={(e) =>
                        updateBeat(sceneIdx, beatIdx, {
                          dialogueSummary: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="sb-field">
                    <label htmlFor={`narration-${beat.id}`}>Narration</label>
                    <textarea
                      id={`narration-${beat.id}`}
                      className="sb-textarea"
                      value={beat.narration ?? ""}
                      onChange={(e) =>
                        updateBeat(sceneIdx, beatIdx, { narration: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="sb-beat-controls">
                  <button
                    type="button"
                    className="sb-btn sb-btn-xs"
                    onClick={() => moveBeatWithin(sceneIdx, beatIdx, -1)}
                    disabled={beatIdx === 0}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn-xs"
                    onClick={() => moveBeatWithin(sceneIdx, beatIdx, 1)}
                    disabled={beatIdx === scene.beats.length - 1}
                  >
                    →
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn-xs"
                    onClick={() => moveBeatAcross(sceneIdx, beatIdx, -1)}
                    disabled={sceneIdx === 0}
                  >
                    Scene ↑
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn-xs"
                    onClick={() => moveBeatAcross(sceneIdx, beatIdx, 1)}
                    disabled={sceneIdx === scenes.length - 1}
                  >
                    Scene ↓
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn-danger sb-btn-xs"
                    onClick={() => removeBeat(sceneIdx, beatIdx)}
                    disabled={scene.beats.length === 1}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>

          <button
            type="button"
            className="sb-btn"
            onClick={() => addBeat(sceneIdx)}
          >
            Add beat
          </button>
        </section>
      ))}

      <button type="button" className="sb-btn" onClick={addScene}>
        Add scene
      </button>
    </main>
  );
}
