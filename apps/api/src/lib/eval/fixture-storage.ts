import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { getSupabaseAdmin } from "../supabase/admin";
import { guessContentType } from "../supabase/storage";

export const EVAL_BUCKET = "eval";

export interface EvalFixtureMediaRef {
  bucket: typeof EVAL_BUCKET;
  objectPath: string;
  sha256: string;
  byteLength: number;
  contentType: string;
}

export interface CaptureEvalFixtureMediaInput {
  bytes: Buffer | Uint8Array;
  filename?: string;
  contentType?: string;
}

export interface CopyEvalFixtureMediaInput {
  sourcePath: string;
  contentType?: string;
}

export type EvalFixtureArtifactRef =
  | ({ kind: "media" } & EvalFixtureMediaRef)
  | { kind: "text"; artifact: unknown };

export function evalFixtureTextArtifact(artifact: unknown): EvalFixtureArtifactRef {
  return { kind: "text", artifact };
}

export function sha256Bytes(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function evalFixtureObjectPath(args: {
  sha256: string;
  filename?: string;
  contentType?: string;
}): string {
  const ext = safeExt(args.filename) ?? extForContentType(args.contentType) ?? ".bin";
  return `${args.sha256}${ext}`;
}

export async function captureEvalFixtureMedia(
  input: CaptureEvalFixtureMediaInput
): Promise<EvalFixtureMediaRef> {
  const body = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const sha256 = sha256Bytes(body);
  const objectPath = evalFixtureObjectPath({
    sha256,
    filename: input.filename,
    contentType: input.contentType,
  });
  const contentType = input.contentType ?? guessContentType(objectPath);

  const { error } = await getSupabaseAdmin()
    .storage.from(EVAL_BUCKET)
    .upload(objectPath, body, {
      contentType,
      upsert: false,
    });
  if (error && !isDuplicateObjectError(error)) throw error;

  return {
    bucket: EVAL_BUCKET,
    objectPath,
    sha256,
    byteLength: body.byteLength,
    contentType,
  };
}

export async function copyEvalFixtureMedia(
  input: CopyEvalFixtureMediaInput
): Promise<EvalFixtureMediaRef> {
  const bytes = await fs.readFile(input.sourcePath);
  return captureEvalFixtureMedia({
    bytes,
    filename: path.basename(input.sourcePath),
    contentType: input.contentType,
  });
}

export function isDuplicateObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    statusCode?: string | number;
    error?: string;
    message?: string;
  };
  const statusCode =
    typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : Number(candidate.statusCode);
  if (statusCode === 409) return true;

  const text = `${candidate.error ?? ""} ${candidate.message ?? ""}`.toLowerCase();
  return (
    text.includes("already exists") ||
    text.includes("duplicate") ||
    text.includes("resource already exists")
  );
}

function safeExt(filename?: string): string | null {
  if (!filename) return null;
  const ext = path.extname(filename).toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(ext)) return null;
  return ext;
}

function extForContentType(contentType?: string): string | null {
  switch (contentType?.toLowerCase()) {
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
      return ".wav";
    case "audio/mp4":
      return ".m4a";
    case "audio/aac":
      return ".aac";
    default:
      return null;
  }
}
