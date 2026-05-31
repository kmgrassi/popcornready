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

function readMp4DurationSec(bytes: Buffer): number | undefined {
  function visit(start: number, end: number): number | undefined {
    for (let pos = start; pos + 8 <= end; ) {
      let size = bytes.readUInt32BE(pos);
      const type = bytes.toString("ascii", pos + 4, pos + 8);
      let headerSize = 8;
      if (size === 1 && pos + 16 <= end) {
        size = Number(bytes.readBigUInt64BE(pos + 8));
        headerSize = 16;
      }
      if (size === 0) size = end - pos;
      if (size < headerSize || pos + size > end) break;

      if (type === "mvhd") {
        const version = bytes[pos + headerSize];
        const offset = pos + headerSize + (version === 1 ? 20 : 12);
        if (offset + (version === 1 ? 12 : 8) > pos + size) return undefined;
        const timescale = bytes.readUInt32BE(offset);
        const duration =
          version === 1
            ? Number(bytes.readBigUInt64BE(offset + 4))
            : bytes.readUInt32BE(offset + 4);
        return timescale > 0 ? duration / timescale : undefined;
      }

      if (type === "moov") {
        const found = visit(pos + headerSize, pos + size);
        if (found !== undefined) return found;
      }

      pos += size;
    }
    return undefined;
  }

  return visit(0, bytes.length);
}

async function durationFor(filePath: string): Promise<number | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
    const duration = readMp4DurationSec(bytes);
    return duration === undefined ? undefined : Math.round(duration * 10) / 10;
  } catch {
    return undefined;
  }
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
        durationSec: await durationFor(filePath),
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
