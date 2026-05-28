// Asset registration for the v1 agent API.
//
// PR1 supports two source modes:
//   - remote_url: persist metadata now; downloading/inspection is an asset_ingest
//     job handled in a later PR, so the asset starts in status "pending".
//   - local_path (AUTH_MODE=local only): copy the file into managed local storage
//     so later operations never depend on the original source file, status "ready".
//
// multipart_upload and generated sources are out of scope for PR1.

import { promises as fs } from "fs";
import path from "path";
import { AuthContext } from "./auth";
import { ApiError } from "./errors";
import { newId } from "./ids";
import {
  AssetKind,
  RegisterAssetInput,
  SCHEMA_VERSIONS,
  inferKindFromName,
} from "./schemas";
import { addAsset, getProject, localDir, mediaUploadDir, V1Asset } from "./store";

function basename(input: string): string {
  try {
    if (/^https?:\/\//.test(input)) {
      const url = new URL(input);
      const fromPath = url.pathname.split("/").filter(Boolean).pop();
      return fromPath || url.hostname;
    }
  } catch {
    // fall through to path basename
  }
  return path.basename(input);
}

function resolveKind(explicit: AssetKind | undefined, filename: string): AssetKind {
  const kind = explicit || inferKindFromName(filename);
  if (!kind) {
    throw new ApiError(
      "asset_invalid",
      "Could not determine asset kind from the filename. Provide `kind` (video, image, or audio)."
    );
  }
  return kind;
}

export async function registerAsset(
  auth: AuthContext,
  projectId: string,
  input: RegisterAssetInput
): Promise<V1Asset> {
  // Ensure the project exists within the resolved workspace.
  await getProject(auth.workspaceId, projectId);

  const now = new Date().toISOString();
  const id = newId("asset");

  if (input.source.type === "remote_url") {
    const filename = input.filename || basename(input.source.url);
    const kind = resolveKind(input.kind, filename);
    const asset: V1Asset = {
      id,
      schemaVersion: SCHEMA_VERSIONS.asset,
      workspaceId: auth.workspaceId,
      projectId,
      kind,
      filename,
      status: "pending",
      source: input.source,
      remoteUrl: input.source.url,
      durationSec: input.durationSec,
      context: input.context,
      createdAt: now,
      updatedAt: now,
    };
    return addAsset(asset);
  }

  if (input.source.type === "local_path") {
    if (!auth.isLocal) {
      throw new ApiError(
        "validation_failed",
        "local_path assets are only allowed when AUTH_MODE=local."
      );
    }
    const srcPath = input.source.path;
    let stat;
    try {
      stat = await fs.stat(srcPath);
    } catch {
      throw new ApiError("asset_invalid", `Local file not found: ${srcPath}`);
    }
    if (!stat.isFile()) {
      throw new ApiError("asset_invalid", `Local path is not a file: ${srcPath}`);
    }

    const filename = input.filename || basename(srcPath);
    const kind = resolveKind(input.kind, filename);

    const ext = path.extname(srcPath);
    const destDir = mediaUploadDir(auth.workspaceId, projectId);
    await fs.mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, `${id}${ext}`);
    await fs.copyFile(srcPath, destPath);
    const storageKey = path.relative(localDir(), destPath);

    const asset: V1Asset = {
      id,
      schemaVersion: SCHEMA_VERSIONS.asset,
      workspaceId: auth.workspaceId,
      projectId,
      kind,
      filename,
      status: "ready",
      source: { type: "local_path", path: srcPath },
      storageKey,
      durationSec: input.durationSec,
      context: input.context,
      createdAt: now,
      updatedAt: now,
    };
    return addAsset(asset);
  }

  throw new ApiError(
    "validation_failed",
    `Asset source "${input.source.type}" is not supported yet. Use remote_url or local_path.`
  );
}
