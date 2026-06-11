import path from "node:path";
import { bucketForVisibility, type StorageVisibility } from "./config";
import { objectStore } from "./object-store";

const CONTENT_TYPES: Record<string, string> = {
  ".aac": "audio/aac",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export function contentTypeForFilename(
  filename: string,
  explicit?: string
): string {
  if (explicit) return explicit;
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

export function assetStorageKey(input: {
  workspaceId: string;
  projectId: string;
  assetId: string;
  filename: string;
}): string {
  return [
    input.workspaceId,
    input.projectId,
    input.assetId,
    path.basename(input.filename),
  ].join("/");
}

export async function writeAssetObject(input: {
  workspaceId: string;
  projectId: string;
  assetId: string;
  filename: string;
  bytes: Buffer;
  visibility: StorageVisibility;
  contentType?: string;
}): Promise<{ storageKey: string; storageBucket: string; contentType: string }> {
  const storageKey = assetStorageKey(input);
  const storageBucket = bucketForVisibility(input.visibility);
  const contentType = contentTypeForFilename(input.filename, input.contentType);
  await objectStore().putObject({
    bucket: storageBucket,
    key: storageKey,
    body: input.bytes,
    contentType,
  });
  return { storageKey, storageBucket, contentType };
}
