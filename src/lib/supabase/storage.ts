// Supabase Storage adapter for asset bytes.
//
// Server-side only: uses the service_role admin client to upload/download asset
// files and to mint signed URLs for the browser. Gated by the same DB_BACKEND
// flag as the Postgres store — when "supabase", the v1 asset writers put bytes in
// the `assets` bucket and persist the object path as the asset's storageKey;
// otherwise bytes stay on local disk under .local/media (unchanged).
//
// The `assets` bucket is private (see the storage-bucket migration), so reads go
// through the admin client (server render/export) or short-lived signed URLs
// (browser). No public bucket access.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { getSupabaseAdmin } from "./admin";

export const ASSET_BUCKET = "assets";

export function useSupabaseStorage(): boolean {
  return (process.env.DB_BACKEND ?? "local").toLowerCase() === "supabase";
}

// Object-path layout mirrors the on-disk layout so the two backends stay legible.
export function uploadObjectPath(
  workspaceId: string,
  projectId: string,
  assetId: string,
  ext: string
): string {
  return `uploads/${workspaceId}/${projectId}/${assetId}${ext}`;
}

export function generatedObjectPath(
  workspaceId: string,
  projectId: string,
  filename: string
): string {
  return `generated/${workspaceId}/${projectId}/${filename}`;
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

export function guessContentType(filenameOrExt: string): string {
  const ext = path.extname(filenameOrExt) || filenameOrExt;
  return CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

export async function uploadAssetObject(
  objectPath: string,
  bytes: Buffer | Uint8Array,
  contentType?: string
): Promise<void> {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { error } = await getSupabaseAdmin()
    .storage.from(ASSET_BUCKET)
    .upload(objectPath, body, {
      contentType: contentType ?? guessContentType(objectPath),
      upsert: true,
    });
  if (error) throw error;
}

// Download an object to a temp file (mirroring its object path so the extension
// is preserved) and return the local path. Used to hand reference files to image
// providers / renderers that need a real filesystem path. Caller may delete it.
export async function downloadAssetObjectToTemp(objectPath: string): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .storage.from(ASSET_BUCKET)
    .download(objectPath);
  if (error) throw error;

  const localPath = path.join(os.tmpdir(), "pr-assets", objectPath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, Buffer.from(await data.arrayBuffer()));
  return localPath;
}

export async function createSignedAssetUrl(
  objectPath: string,
  expiresInSec = 3600
): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .storage.from(ASSET_BUCKET)
    .createSignedUrl(objectPath, expiresInSec);
  if (error) throw error;
  return data.signedUrl;
}
