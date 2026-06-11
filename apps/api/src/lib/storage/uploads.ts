import path from "path";
import type { CompletedPart } from "@aws-sdk/client-s3";
import { ApiError } from "@/core/errors";
import type { AuthContext } from "@/lib/api/v1/auth";
import {
  completeDirectUploadAsset as updateDirectUploadAsset,
  getAsset,
  reserveDirectUploadAsset,
  type V1Asset,
} from "@/lib/api/v1/store";
import type {
  CompleteAssetUploadInput,
  DirectAssetUploadInput,
} from "@/lib/api/v1/schemas";
import {
  readStorageConfig,
  visibilityForBucket,
} from "./config";
import {
  completeMultipartUpload,
  createMultipartUploadTarget,
  createPresignedPutTarget,
  objectExists,
} from "./object-store";

export interface DirectAssetUploadResponse {
  assetId: string;
  key: string;
  bucket: string;
  method: "put" | "multipart";
  contentType: string;
  expiresAt: string;
  put?: {
    url: string;
    headers: Record<string, string>;
  };
  multipart?: {
    uploadId: string;
    partSizeBytes: number;
    parts: { partNumber: number; url: string }[];
  };
}

function safeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^\w.\-()[\] ]+/g, "_").trim();
  return base || "asset.bin";
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
    safeFilename(input.filename),
  ].join("/");
}

export async function createDirectAssetUpload(
  auth: AuthContext,
  projectId: string,
  input: DirectAssetUploadInput
): Promise<DirectAssetUploadResponse> {
  const config = readStorageConfig();
  if (config.backend !== "s3") {
    throw new ApiError(
      "not_implemented",
      "Direct browser uploads require STORAGE_BACKEND=s3."
    );
  }

  const reservation = await reserveDirectUploadAsset(auth.workspaceId, projectId, input);
  const key = assetStorageKey({
    workspaceId: auth.workspaceId,
    projectId,
    assetId: reservation.asset.id,
    filename: input.filename,
  });

  if (
    reservation.asset.storageKey !== key ||
    !reservation.asset.storageBucket
  ) {
    throw new ApiError(
      "internal_error",
      "The upload reservation did not match the storage target."
    );
  }

  if (input.sizeBytes >= config.multipartThresholdBytes) {
    const multipart = await createMultipartUploadTarget({
      visibility: reservation.effectiveVisibility,
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    });
    return {
      assetId: reservation.asset.id,
      key,
      bucket: reservation.asset.storageBucket,
      method: "multipart",
      contentType: input.contentType,
      expiresAt: multipart.expiresAt,
      multipart,
    };
  }

  const put = await createPresignedPutTarget({
    visibility: reservation.effectiveVisibility,
    key,
    contentType: input.contentType,
  });
  return {
    assetId: reservation.asset.id,
    key,
    bucket: reservation.asset.storageBucket,
    method: "put",
    contentType: input.contentType,
    expiresAt: put.expiresAt,
    put: {
      url: put.url,
      headers: put.headers,
    },
  };
}

function completedParts(parts: CompleteAssetUploadInput["parts"]): CompletedPart[] {
  return (parts ?? []).map((part) => ({
    PartNumber: part.partNumber,
    ETag: part.etag,
  }));
}

export async function completeDirectAssetUpload(
  auth: AuthContext,
  projectId: string,
  assetId: string,
  input: CompleteAssetUploadInput
): Promise<V1Asset> {
  const config = readStorageConfig();
  if (config.backend !== "s3") {
    throw new ApiError(
      "not_implemented",
      "Direct browser uploads require STORAGE_BACKEND=s3."
    );
  }

  if (input.uploadId) {
    if (!input.parts?.length) {
      throw new ApiError(
        "validation_failed",
        "Multipart completion requires uploaded parts."
      );
    }
    const current = await getAsset(
      auth.workspaceId,
      projectId,
      assetId
    );
    if (current.status !== "pending") {
      throw new ApiError("asset_invalid", "Upload has already been completed.");
    }
    if (!current.storageKey || !current.storageBucket) {
      throw new ApiError("asset_invalid", "Upload reservation is missing storage.");
    }
    await completeMultipartUpload({
      visibility: visibilityForBucket(config, current.storageBucket),
      key: current.storageKey,
      uploadId: input.uploadId,
      parts: completedParts(input.parts),
    });
  }

  const asset = await getAsset(
    auth.workspaceId,
    projectId,
    assetId
  );
  if (asset.status !== "pending") {
    throw new ApiError("asset_invalid", "Upload has already been completed.");
  }
  if (!asset.storageKey || !asset.storageBucket) {
    throw new ApiError("asset_invalid", "Upload reservation is missing storage.");
  }
  const exists = await objectExists({
    visibility: visibilityForBucket(config, asset.storageBucket),
    key: asset.storageKey,
  });
  if (!exists) {
    throw new ApiError(
      "asset_invalid",
      "Uploaded object was not found in the reserved bucket."
    );
  }

  return updateDirectUploadAsset(auth.workspaceId, projectId, assetId, {
    status: "ready",
  });
}
