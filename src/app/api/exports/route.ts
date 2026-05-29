import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const EXPORT_DIR = path.join(process.cwd(), "public", "exports");

interface ExportVideo {
  id: string;
  url: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  durationSec?: number;
  hasAudioOverlay: boolean;
  silentUrl?: string;
  overlayUrl?: string;
}

interface ExportGroup {
  id: string;
  createdAtMs: number;
  silent?: ExportVideo;
  overlay?: ExportVideo;
}

function baseExportId(filename: string): string {
  return filename.replace(/_overlay\.mp4$/, ".mp4").replace(/\.mp4$/, "");
}

export async function GET() {
  try {
    await fs.mkdir(EXPORT_DIR, { recursive: true });
    const entries = await fs.readdir(EXPORT_DIR, { withFileTypes: true });
    const groups = new Map<string, ExportGroup>();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".mp4")) continue;

      const filePath = path.join(EXPORT_DIR, entry.name);
      const stat = await fs.stat(filePath);
      const id = baseExportId(entry.name);
      const url = `/exports/${entry.name}`;
      const isOverlay = entry.name.endsWith("_overlay.mp4");
      const video: ExportVideo = {
        id,
        url,
        filename: entry.name,
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        hasAudioOverlay: isOverlay,
      };

      const group = groups.get(id) || {
        id,
        createdAtMs: stat.mtimeMs,
      };
      group.createdAtMs = Math.max(group.createdAtMs, stat.mtimeMs);
      if (isOverlay) group.overlay = video;
      else group.silent = video;
      groups.set(id, group);
    }

    const videos = [...groups.values()]
      .map((group) => {
        const primary = group.overlay || group.silent!;
        return {
          ...primary,
          url: primary.url,
          filename: primary.filename,
          createdAt: new Date(group.createdAtMs).toISOString(),
          hasAudioOverlay: Boolean(group.overlay),
          silentUrl: group.silent?.url,
          overlayUrl: group.overlay?.url,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

    return NextResponse.json({ videos });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Unable to list exports" },
      { status: 500 }
    );
  }
}
