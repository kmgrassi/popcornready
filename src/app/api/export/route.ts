import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { getProject } from "@/lib/store";
import { dims, timelineDurationSec } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const EXPORT_DIR = path.join(process.cwd(), "public", "exports");

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

    const inputProps = {
      timeline: project.timeline,
      clips: project.clips,
      baseUrl: origin,
    };

    const entry = path.join(process.cwd(), "src", "remotion", "index.ts");
    const serveUrl = await bundle({ entryPoint: entry });
    await ensureBrowser();

    const composition = await selectComposition({
      serveUrl,
      id: "main",
      inputProps,
    });

    await fs.mkdir(EXPORT_DIR, { recursive: true });
    const outName = `export_${Date.now()}.mp4`;
    const outputLocation = path.join(EXPORT_DIR, outName);

    await renderMedia({
      composition: { ...composition, durationInFrames, fps, width, height },
      serveUrl,
      codec: "h264",
      outputLocation,
      inputProps,
    });

    return NextResponse.json({ url: `/exports/${outName}` });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Export failed" },
      { status: 500 }
    );
  }
}
