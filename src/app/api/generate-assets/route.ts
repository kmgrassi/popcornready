import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { addClip, getProject } from "@/lib/store";
import { Clip } from "@/lib/types";
import { providerFor } from "@/lib/generative/providers";
import { GenerativeAssetKind } from "@/lib/generative/types";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const GENERATED_DIR = path.join(process.cwd(), "public", "generated");

function newId(prefix: string): string {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

function localPublicPath(url: string): string | null {
  if (!url.startsWith("/uploads/") && !url.startsWith("/generated/")) {
    return null;
  }
  const filePath = path.normalize(path.join(process.cwd(), "public", url));
  const publicRoot = path.join(process.cwd(), "public");
  if (!filePath.startsWith(publicRoot)) return null;
  return filePath;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const providerName = String(body.provider || "openai");
    const kind = String(body.kind || "image") as GenerativeAssetKind;
    const prompt = String(body.prompt || "").trim();
    const description = String(body.description || prompt);
    const durationSec = Number(body.durationSec) || (kind === "image" ? 4 : 8);
    const referenceClipIds = Array.isArray(body.referenceClipIds)
      ? body.referenceClipIds.map(String)
      : [];

    if (kind !== "image" && kind !== "video") {
      return NextResponse.json(
        { error: "kind must be image or video." },
        { status: 400 }
      );
    }
    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    const project = await getProject();
    const referencePaths = referenceClipIds
      .map((id: string) =>
        project.clips.find((clip: Clip) => clip.id === id)
      )
      .filter((clip: Clip | undefined): clip is Clip => Boolean(clip))
      .map((clip: Clip) => localPublicPath(clip.url))
      .filter((filePath: string | null): filePath is string =>
        Boolean(filePath)
      );

    const provider = providerFor(providerName);
    const result = await provider.generateAsset({
      provider: provider.name,
      kind,
      prompt,
      referencePaths,
      model: body.model ? String(body.model) : undefined,
      size: body.size ? String(body.size) : undefined,
      quality: body.quality,
      seconds: body.seconds ? Number(body.seconds) : undefined,
    });

    await fs.mkdir(GENERATED_DIR, { recursive: true });
    const id = newId(kind === "image" ? "img" : "vid");
    const filename = `${id}.${result.extension}`;
    await fs.writeFile(path.join(GENERATED_DIR, filename), result.bytes);

    const clip: Clip = {
      id,
      filename,
      url: `/generated/${filename}`,
      kind: result.kind,
      durationSec,
      description,
      source: "generated",
      generatedBy: {
        provider: result.provider,
        model: result.model,
        prompt: result.prompt,
      },
    };

    const updated = await addClip(clip);
    return NextResponse.json({ clip, project: updated });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Asset generation failed" },
      { status: 500 }
    );
  }
}
