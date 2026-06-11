import type { V1Asset } from "@/lib/api/v1/store";
import { readStorageConfig, visibilityForBucket } from "./config";
import { createObjectStore } from "./object-store";

function localStorageUrl(storageKey: string): string {
  return `/${storageKey.replace(/^media\//, "")}`;
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

  const visibility = visibilityForBucket(config, asset.storageBucket);
  const store = createObjectStore(config);
  if (visibility === "public") return store.objectUrl(asset.storageKey, visibility);

  return store.signedObjectUrl(asset.storageKey, visibility);
}
