import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getProject } from "@/lib/store";
import { Clip, dims, timelineDurationSec } from "@/lib/types";
import {
  DEFAULT_DURATION_POLICY,
  DURATION_POLICIES,
  DurationPolicy,
  evaluateExportPolicy,
} from "@/lib/audio-alignment";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const EXPORT_DIR = path.join(process.cwd(), "public", "exports");

function publicPathForClip(url: string): string | null {
  if (!url.startsWith("/uploads/") && !url.startsWith("/generated/")) return null;
  const filePath = path.normalize(path.join(process.cwd(), "public", url));
  const publicRoot = path.join(process.cwd(), "public");
  return filePath.startsWith(publicRoot) ? filePath : null;
}

function audioClipDurationSec(clip: Clip): number {
  return clip.measuredDurationSec && clip.measuredDurationSec > 0
    ? clip.measuredDurationSec
    : clip.durationSec || 0;
}

function parseDurationPolicy(value: unknown): DurationPolicy {
  return DURATION_POLICIES.includes(value as DurationPolicy)
    ? (value as DurationPolicy)
    : DEFAULT_DURATION_POLICY;
}

// Accepts the new `audioAssetIds` array and the legacy single
// `selectedAudioClipId` for backward compatibility with the browser UI.
function parseAudioClipIds(body: any): string[] {
  if (Array.isArray(body.audioAssetIds)) {
    return body.audioAssetIds.map(String).filter(Boolean);
  }
  if (typeof body.selectedAudioClipId === "string" && body.selectedAudioClipId) {
    return [body.selectedAudioClipId];
  }
  return [];
}

export async function POST(req: NextRequest) {
  try {
    const project = await getProject();
    if (!project.timeline || project.timeline.segments.length === 0) {
      return NextResponse.json(
        { error: "Nothing to export — generate a cut first." },
        { status: 400 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const durationPolicy = parseDurationPolicy(body.durationPolicy);
    const maxDeltaSec =
      typeof body.maxDeltaSec === "number" ? body.maxDeltaSec : undefined;
    const requestedAudioIds = parseAudioClipIds(body);

    const audioClips: Clip[] = [];
    for (const id of requestedAudioIds) {
      const clip = project.clips.find((c) => c.id === id);
      if (!clip || clip.kind !== "audio") {
        return NextResponse.json(
          { error: `Selected audio clip is not available for export: ${id}` },
          { status: 400 }
        );
      }
      audioClips.push(clip);
    }

    // Alignment validation step: compare the timeline against the longest
    // selected audio clip (overlays play concurrently from t=0) and apply the
    // requested duration policy before we spend time rendering.
    const tlDurationSec = timelineDurationSec(project.timeline);
    const audioDurationSec = audioClips.reduce(
      (max, clip) => Math.max(max, audioClipDurationSec(clip)),
      0
    );
    const alignment = evaluateExportPolicy({
      policy: durationPolicy,
      timelineDurationSec: tlDurationSec,
      audioDurationSec,
      maxDeltaSec,
    });

    if (!alignment.error && !alignment.ok) {
      // Defensive: should not happen, but never render an export we deemed
      // not-ok without an explanation.
      return NextResponse.json(
        { error: "Export blocked by audio alignment policy.", alignment },
        { status: 422 }
      );
    }
    if (alignment.error) {
      return NextResponse.json(
        { error: alignment.error.message, code: alignment.error.code, alignment },
        { status: 422 }
      );
    }

    // Lazy-import the heavy Remotion packages so dev startup stays fast.
    const { bundle } = await import("@remotion/bundler");
    const { selectComposition, renderMedia, ensureBrowser } = await import(
      "@remotion/renderer"
    );

    // Clips are served by this same Next server; Chromium needs absolute URLs.
    const origin = new URL(req.url).origin;
    const fps = project.timeline.fps || 30;
    const { width, height } = dims(project.timeline.aspectRatio);
    const durationInFrames = Math.max(
      1,
      Math.round(alignment.exportDurationSec * fps)
    );

    const baseInputProps = {
      timeline: project.timeline,
      clips: project.clips,
      baseUrl: origin,
    };

    const entry = path.join(process.cwd(), "src", "remotion", "index.ts");
    const serveUrl = await bundle({ entryPoint: entry });
    await ensureBrowser();

    const silentInputProps = { ...baseInputProps, includeAudio: false };
    const silentComposition = await selectComposition({
      serveUrl,
      id: "main",
      inputProps: silentInputProps,
    });

    await fs.mkdir(EXPORT_DIR, { recursive: true });
    const exportId = Date.now();
    const silentName = `export_${exportId}.mp4`;
    const silentOutputLocation = path.join(EXPORT_DIR, silentName);

    await renderMedia({
      composition: { ...silentComposition, durationInFrames, fps, width, height },
      serveUrl,
      codec: "h264",
      outputLocation: silentOutputLocation,
      inputProps: silentInputProps,
      muted: true,
    });

    let overlayUrl: string | null = null;
    if (audioClips.length > 0) {
      const missingAudio = [];
      for (const clip of audioClips) {
        if (clip.url.startsWith("http")) continue;
        const filePath = publicPathForClip(clip.url);
        if (!filePath) {
          missingAudio.push(clip);
          continue;
        }
        try {
          await fs.access(filePath);
        } catch {
          missingAudio.push(clip);
        }
      }
      if (missingAudio.length > 0) {
        throw new Error("One or more audio clips could not be resolved for export.");
      }

      const overlayName = `export_${exportId}_overlay.mp4`;
      const overlayOutputLocation = path.join(EXPORT_DIR, overlayName);
      const overlayInputProps = {
        ...baseInputProps,
        includeAudio: true,
        audioClipIds: audioClips.map((clip) => clip.id),
      };
      const overlayComposition = await selectComposition({
        serveUrl,
        id: "main",
        inputProps: overlayInputProps,
      });
      await renderMedia({
        composition: { ...overlayComposition, durationInFrames, fps, width, height },
        serveUrl,
        codec: "h264",
        outputLocation: overlayOutputLocation,
        inputProps: overlayInputProps,
      });
      overlayUrl = `/exports/${overlayName}`;
    }

    const silentUrl = `/exports/${silentName}`;
    return NextResponse.json({
      url: overlayUrl || silentUrl,
      silentUrl,
      overlayUrl,
      audioUrls: audioClips.map((clip) => clip.url),
      alignment,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Export failed" },
      { status: 500 }
    );
  }
}
