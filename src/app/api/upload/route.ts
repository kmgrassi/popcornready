import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { addClip } from "@/lib/store";
import { Clip } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const durationSec = parseFloat(String(form.get("durationSec") || "0"));
    const description = String(form.get("description") || "");

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const id = "clip_" + Math.random().toString(36).slice(2, 10);
    const safeBase = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stored = `${id}_${safeBase}`;
    const bytes = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(path.join(UPLOAD_DIR, stored), bytes);

    const kind = file.type.startsWith("image/") ? "image" : "video";
    const clip: Clip = {
      id,
      filename: file.name,
      url: `/uploads/${stored}`,
      kind,
      durationSec: Number.isFinite(durationSec) && durationSec > 0
        ? durationSec
        : kind === "image"
          ? 4
          : 0,
      description,
      source: "upload",
    };
    const project = await addClip(clip);
    return NextResponse.json({ clip, project });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Upload failed" },
      { status: 500 }
    );
  }
}
