import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  downloadOpenAIVideoById,
  getOpenAIVideoById,
} from "@/lib/generative/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GENERATED_DIR = path.join(
  process.cwd(),
  "public",
  "debug",
  "openai-videos"
);

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
    const pollIntervalMs =
      typeof body.pollIntervalMs === "number" ? body.pollIntervalMs : undefined;
    const timeoutMs =
      typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;

    if (!videoId) {
      return NextResponse.json(
        { error: "videoId is required" },
        { status: 400 }
      );
    }

    const video = await getOpenAIVideoById(videoId, {
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });

    if (video.status !== "completed") {
      return NextResponse.json(
        {
          status: video.status,
          videoId,
          message:
            video.error?.message ??
            `Job is not completed yet (status=${video.status}).`,
          job: video,
        },
        { status: 202 }
      );
    }

    const bytes = await downloadOpenAIVideoById(videoId);

    await fs.mkdir(GENERATED_DIR, { recursive: true });
    const filename = `${newId("openai_fetched")}.mp4`;
    const filePath = path.join(GENERATED_DIR, filename);
    await fs.writeFile(filePath, bytes);

    return NextResponse.json({
      status: "ok",
      job: video,
      source: {
        videoId,
        filename,
        url: `/debug/openai-videos/${filename}`,
      },
      sizeBytes: bytes.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "OpenAI video fetch by ID failed" },
      { status: 500 }
    );
  }
}
