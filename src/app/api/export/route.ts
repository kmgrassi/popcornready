import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getProject } from "@/lib/store";
import { dims, timelineDurationSec } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const EXPORT_DIR = path.join(process.cwd(), "public", "exports");

function publicPathForClip(url: string): string | null {
  if (!url.startsWith("/uploads/") && !url.startsWith("/generated/")) return null;
  const filePath = path.normalize(path.join(process.cwd(), "public", url));
  const publicRoot = path.join(process.cwd(), "public");
  return filePath.startsWith(publicRoot) ? filePath : null;
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
      Math.round(timelineDurationSec(project.timeline) * fps)
    );

    const baseInputProps = {
      timeline: project.timeline,
      clips: project.clips,
      baseUrl: origin,
    };
    const body = await req.json().catch(() => ({}));
    const selectedAudioClipId =
      typeof body.selectedAudioClipId === "string"
        ? body.selectedAudioClipId
        : null;
    const selectedAudioClip = selectedAudioClipId
      ? project.clips.find((clip) => clip.id === selectedAudioClipId)
      : null;

    if (selectedAudioClipId && selectedAudioClip?.kind !== "audio") {
      return NextResponse.json(
        { error: "Selected audio clip is not available for export." },
        { status: 400 }
      );
    }

    const audioClips = selectedAudioClip ? [selectedAudioClip] : [];

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
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Export failed" },
      { status: 500 }
    );
  }
}
