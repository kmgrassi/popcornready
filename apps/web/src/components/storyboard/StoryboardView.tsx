import { useMemo, useState } from "react";
import type { Beat, EditPlan, Scene } from "@popcorn/shared/types";
import type { Asset } from "@popcorn/shared/assets/types";
import { MediaViewer, type MediaViewerItem } from "../media/MediaViewer";

// Read-only storyboard surface (docs/scopes/storyboard-scenes.md Part C / PR5).
// Renders an EditPlan as Scenes → a grid of beat tiles. Each tile shows the
// beat's `beat_storyboard` sketch (resolved from the project's pooled assets by
// role + depicts.beatId), plus the beat's name, duration, and one-line intent.
// Editing lands in PR5's successor; this view never mutates.

export interface StoryboardViewProps {
  plan: EditPlan | null;
  assets: Asset[];
  loading?: boolean;
  error?: string | null;
}

// Index storyboard sketch tiles by the beat they depict, so each tile resolves
// in O(1). A beat may have at most one active storyboard sketch; if several
// exist (regenerations), the last wins — pooled assets are append-only.
function indexStoryboardTilesByBeat(assets: Asset[]): Map<string, Asset> {
  const byBeat = new Map<string, Asset>();
  for (const asset of assets) {
    if (asset.role !== "beat_storyboard") continue;
    const beatId = asset.depicts?.beatId;
    if (!beatId) continue;
    byBeat.set(beatId, asset);
  }
  return byBeat;
}

function formatDuration(durationSec: number): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return "—";
  // Keep it terse: whole seconds, one decimal only when sub-second matters.
  const rounded = Math.round(durationSec * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
}

function assetViewerItem(asset: Asset): MediaViewerItem {
  return {
    id: asset.id,
    kind: asset.kind,
    title: asset.media.filename || asset.description || asset.id,
    filename: asset.media.filename,
    durationSec: asset.media.durationSec,
    url: asset.media.url,
    thumbnailUrl: asset.kind === "image" ? asset.media.url : undefined,
  };
}

export function StoryboardView({
  plan,
  assets,
  loading = false,
  error = null,
}: StoryboardViewProps) {
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const tilesByBeat = useMemo(
    () => indexStoryboardTilesByBeat(assets),
    [assets]
  );
  const storyboardTiles = useMemo(
    () => Array.from(tilesByBeat.values()),
    [tilesByBeat]
  );
  const selectedIndex = selectedAssetId
    ? storyboardTiles.findIndex((asset) => asset.id === selectedAssetId)
    : -1;
  const selectedAsset = selectedIndex >= 0 ? storyboardTiles[selectedIndex] : null;

  const scenes = plan?.scenes ?? [];
  const beatCount = useMemo(
    () => scenes.reduce((sum, scene) => sum + (scene.beats?.length ?? 0), 0),
    [scenes]
  );

  return (
    <main className="storyboard-shell">
      <header className="storyboard-head">
        <h1 className="storyboard-title">Storyboard</h1>
        <p className="muted">
          A sketch of how your video is laid out — scenes top-to-bottom, beats
          left-to-right. Read-only preview.
        </p>
        {plan && (
          <div className="storyboard-meta muted">
            {plan.style} · {plan.targetLengthSec}s · {scenes.length} scene
            {scenes.length === 1 ? "" : "s"} · {beatCount} beat
            {beatCount === 1 ? "" : "s"}
          </div>
        )}
      </header>

      {error ? (
        <div className="storyboard-state error">{error}</div>
      ) : loading ? (
        <div className="storyboard-state muted">Loading storyboard…</div>
      ) : scenes.length === 0 ? (
        <div className="storyboard-state muted">
          No storyboard yet — generate one to sketch out your scenes and beats.
        </div>
      ) : (
        <div className="storyboard-scenes">
          {scenes.map((scene, index) => (
            <SceneSection
              key={scene.id || `scene-${index}`}
              scene={scene}
              index={index}
              tilesByBeat={tilesByBeat}
              onViewAsset={setSelectedAssetId}
            />
          ))}
        </div>
      )}
      <MediaViewer
        item={selectedAsset ? assetViewerItem(selectedAsset) : null}
        hasPrevious={selectedIndex > 0}
        hasNext={selectedIndex >= 0 && selectedIndex < storyboardTiles.length - 1}
        onClose={() => setSelectedAssetId(null)}
        onPrevious={() => {
          if (selectedIndex > 0) setSelectedAssetId(storyboardTiles[selectedIndex - 1].id);
        }}
        onNext={() => {
          if (selectedIndex >= 0 && selectedIndex < storyboardTiles.length - 1) {
            setSelectedAssetId(storyboardTiles[selectedIndex + 1].id);
          }
        }}
      />
    </main>
  );
}

function SceneSection({
  scene,
  index,
  tilesByBeat,
  onViewAsset,
}: {
  scene: Scene;
  index: number;
  tilesByBeat: Map<string, Asset>;
  onViewAsset: (assetId: string) => void;
}) {
  const beats = scene.beats ?? [];
  return (
    <section className="storyboard-scene" aria-label={`Scene ${index + 1}`}>
      <div className="storyboard-scene-head">
        <div className="storyboard-scene-index">{index + 1}</div>
        <div className="storyboard-scene-titles">
          <h2 className="storyboard-scene-name">
            {scene.name || `Scene ${index + 1}`}
          </h2>
          {scene.setting && (
            <div className="storyboard-scene-setting muted">{scene.setting}</div>
          )}
        </div>
        {scene.mood && (
          <div className="storyboard-scene-mood muted">{scene.mood}</div>
        )}
      </div>

      {beats.length === 0 ? (
        <div className="storyboard-state muted">No beats in this scene yet.</div>
      ) : (
        <div className="storyboard-beat-grid">
          {beats.map((beat, beatIndex) => (
            <BeatTile
              key={beat.id || `beat-${index}-${beatIndex}`}
              beat={beat}
              tile={beat.id ? tilesByBeat.get(beat.id) : undefined}
              onViewAsset={onViewAsset}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BeatTile({
  beat,
  tile,
  onViewAsset,
}: {
  beat: Beat;
  tile?: Asset;
  onViewAsset: (assetId: string) => void;
}) {
  return (
    <article className="storyboard-beat-tile">
      <div className="storyboard-beat-sketch">
        {tile ? (
          <img
            className="storyboard-beat-img"
            src={tile.media.url}
            alt={`Storyboard sketch for "${beat.name}"`}
            loading="lazy"
            role="button"
            tabIndex={0}
            onClick={() => onViewAsset(tile.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onViewAsset(tile.id);
              }
            }}
          />
        ) : (
          <div className="storyboard-beat-placeholder muted">
            No sketch yet
          </div>
        )}
      </div>
      <div className="storyboard-beat-body">
        <div className="storyboard-beat-head">
          <span className="storyboard-beat-name">{beat.name}</span>
          <span className="storyboard-beat-duration muted">
            {formatDuration(beat.durationSec)}
          </span>
        </div>
        {beat.intent && (
          <p className="storyboard-beat-intent muted" title={beat.intent}>
            {beat.intent}
          </p>
        )}
      </div>
    </article>
  );
}
