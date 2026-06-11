import type { V1Asset } from "@/lib/api/v1/store";
import { readStorageConfig, type AssetStorageBucket } from "./config";
import { createPresignedGetUrl } from "./object-store";

function localStorageUrl(storageKey: string): string {
  return `/${storageKey.replace(/^media\//, "")}`;
}

function publicObjectUrl(storageKey: string): string | null {
  const config = readStorageConfig();
  if (!config.publicUrlBase) return null;
  return `${config.publicUrlBase}/${storageKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export async function resolveAssetUrlForGeneration(
  asset: Pick<V1Asset, "id" | "filename" | "remoteUrl" | "storageKey" | "storageBucket">
): Promise<string> {
  if (asset.remoteUrl) return asset.remoteUrl;
  if (!asset.storageKey) return `/assets/${asset.id}/${asset.filename}`;

  const config = readStorageConfig();
  if (config.backend !== "s3" || !asset.storageBucket) {
    return localStorageUrl(asset.storageKey);
  }

  if (asset.storageBucket === "assets-public") {
    const publicUrl = publicObjectUrl(asset.storageKey);
    if (publicUrl) return publicUrl;
  }

  return createPresignedGetUrl({
    bucket: asset.storageBucket as AssetStorageBucket,
    key: asset.storageKey,
  });
}
