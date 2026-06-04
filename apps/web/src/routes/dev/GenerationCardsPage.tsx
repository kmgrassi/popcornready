import { useState } from "react";
import StageItemCard, {
  type StageItemAsset,
} from "../../components/generation-progress/StageItemCard";
import type { GenerationStageItem } from "@popcorn/shared/v1/types";

const imagePoster =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#ff6a3d"/>' +
      '<stop offset="1" stop-color="#4da3ff"/>' +
      "</linearGradient></defs>" +
      '<rect width="640" height="360" fill="url(#g)"/>' +
      '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" ' +
      'fill="white" font-family="-apple-system, Arial" font-size="34" ' +
      'font-weight="800">demo asset</text>' +
      "</svg>",
  );

const timelinePreview = `Scene 1 - 0.0s-4.2s - hook - "Coffee should not be this hard."
Scene 2 - 4.2s-10.8s - problem - barista juggling pour-over
Scene 3 - 10.8s-22.0s - product - single-press carafe close-up
Scene 4 - 22.0s-30.0s - CTA - "Skip the queue. Get one shipped."`;

const captionPreview =
  "00:00 - Coffee should not be this hard.\n" +
  "00:04 - Watch this.\n" +
  "00:08 - One press. One perfect cup.\n" +
  "00:24 - Get yours shipped today.";

interface DemoEntry {
  item: GenerationStageItem;
  asset?: StageItemAsset;
  statusMessage?: string;
}

type DemoSeedEntry = Omit<DemoEntry, "item"> & {
  item: Omit<GenerationStageItem, "createdAt" | "updatedAt">;
};

const demoTimestamp = "2026-05-31T09:00:00.000Z";

const rawSeedItems: DemoSeedEntry[] = [
  {
    item: {
      itemId: "i-1",
      stageId: "stage-assets",
      kind: "image",
      label: "Visual 3 of 8 - Opening hook",
      status: "running",
      provider: "imagen-3",
      progressPercent: 62,
      promptPreview:
        "Cinematic warehouse, golden hour, low-angle on a hand pulling a lever, soft volumetric light",
    },
    statusMessage: "Generating still",
  },
  {
    item: {
      itemId: "i-2",
      stageId: "stage-assets",
      kind: "video",
      label: "Beat 4 - Product reveal",
      status: "running",
      provider: "veo-3",
      promptPreview:
        "Slow dolly across a matte-black table, single press carafe rotates on a small turntable",
    },
    statusMessage: "Provider queue - position 2 of 5",
  },
  {
    item: {
      itemId: "i-3",
      stageId: "stage-assets",
      kind: "image",
      label: "Visual 5 of 8 - Mid-roll detail",
      status: "queued",
    },
  },
  {
    item: {
      itemId: "i-4",
      stageId: "stage-assets",
      kind: "video",
      label: "Beat 6 - Reaction shot",
      status: "queued",
    },
  },
  {
    item: {
      itemId: "i-5",
      stageId: "stage-assets",
      kind: "image",
      label: "Visual 1 - Hero shot",
      status: "succeeded",
      assetId: "asset-img-1",
    },
    asset: { url: imagePoster },
  },
  {
    item: {
      itemId: "i-6",
      stageId: "stage-assets",
      kind: "video",
      label: "Visual 2 - Establishing shot",
      status: "succeeded",
      assetId: "asset-vid-1",
    },
    asset: {
      url: "/dev/generation-cards/sample-video.mp4",
      thumbnailUrl: imagePoster,
      mimeType: "video/mp4",
    },
  },
  {
    item: {
      itemId: "i-7",
      stageId: "stage-audio",
      kind: "audio",
      label: "Narration - draft",
      status: "running",
      provider: "elevenlabs",
      progressPercent: 34,
    },
    statusMessage: "Synthesizing voice",
  },
  {
    item: {
      itemId: "i-8",
      stageId: "stage-audio",
      kind: "audio",
      label: "Narration - v2",
      status: "succeeded",
      assetId: "asset-aud-1",
    },
    asset: {
      url: "/dev/generation-cards/sample-audio.mp3",
      durationSec: 58,
      mimeType: "audio/mpeg",
    },
  },
  {
    item: {
      itemId: "i-9",
      stageId: "stage-quality",
      kind: "caption",
      label: "Captions - en",
      status: "succeeded",
      artifactId: "artifact-cap-1",
    },
    asset: { text: captionPreview },
  },
  {
    item: {
      itemId: "i-10",
      stageId: "stage-timeline",
      kind: "timeline",
      label: "Scene plan",
      status: "succeeded",
      artifactId: "artifact-timeline-1",
    },
    asset: { text: timelinePreview },
  },
  {
    item: {
      itemId: "i-11",
      stageId: "stage-export",
      kind: "export",
      label: "Final cut - 1080p",
      status: "running",
      provider: "remotion",
      progressPercent: 23,
    },
    statusMessage: "Rendering frame 412 of 1800",
  },
  {
    item: {
      itemId: "i-12",
      stageId: "stage-export",
      kind: "export",
      label: "Final cut - 1080p",
      status: "succeeded",
      artifactId: "artifact-export-1",
    },
    asset: {
      url: "/dev/generation-cards/sample-export.mp4",
      thumbnailUrl: imagePoster,
      mimeType: "video/mp4",
    },
  },
  {
    item: {
      itemId: "i-13",
      stageId: "stage-assets",
      kind: "image",
      label: "Visual 7 of 8 - Closing detail",
      status: "failed",
      retryable: true,
      error: {
        code: "provider_timeout",
        message: "Image provider timed out after 45s. Try again to re-queue.",
        retryable: true,
      },
    },
  },
  {
    item: {
      itemId: "i-14",
      stageId: "stage-assets",
      kind: "video",
      label: "Beat 8 - Brand stinger",
      status: "failed",
      retryable: false,
      error: {
        code: "content_policy",
        message: "Provider rejected the prompt under its content policy.",
        retryable: false,
      },
    },
  },
  {
    item: {
      itemId: "i-15",
      stageId: "stage-assets",
      kind: "video",
      label: "Beat 9 - Outro shot",
      status: "canceled",
    },
  },
];

const seedItems: DemoEntry[] = rawSeedItems.map(({ item, ...entry }) => ({
  ...entry,
  item: {
    ...item,
    createdAt: demoTimestamp,
    updatedAt: demoTimestamp,
  },
}));

export function GenerationCardsPage() {
  const [items, setItems] = useState<DemoEntry[]>(seedItems);
  const [lastRetry, setLastRetry] = useState<string | null>(null);

  const handleRetry = (item: GenerationStageItem) => {
    setLastRetry(item.itemId);
    setItems((prev) =>
      prev.map((entry) =>
        entry.item.itemId === item.itemId
          ? {
              ...entry,
              item: {
                ...entry.item,
                status: "queued",
                error: undefined,
                retryable: undefined,
              },
            }
          : entry,
      ),
    );
  };

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 24px 80px" }}>
      <header style={{ marginBottom: 24 }}>
        <span className="lp-eyebrow">Dev harness - generation cards</span>
        <h1 style={{ fontSize: 28, margin: "12px 0 6px" }}>
          Progressive asset and audio cards
        </h1>
        <p className="muted" style={{ maxWidth: 640, lineHeight: 1.5 }}>
          Reviewable preview of the queued, running, completed, failed, and
          canceled card states for each <code>GenerationStageItem.kind</code>.
          This page seeds mock items while persistence, polling, async start,
          and the progress shell continue to land separately.
        </p>
        {lastRetry && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Retried <code>{lastRetry}</code> and re-queued.
          </p>
        )}
      </header>

      <section className="stage-item-grid" aria-label="Stage item cards">
        {items.map(({ item, asset, statusMessage }) => (
          <StageItemCard
            key={item.itemId}
            item={item}
            asset={asset}
            statusMessage={statusMessage}
            onRetry={handleRetry}
          />
        ))}
      </section>
    </main>
  );
}

export default GenerationCardsPage;
