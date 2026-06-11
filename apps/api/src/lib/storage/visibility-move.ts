import { randomUUID } from "node:crypto";

export type AssetVisibility = "public" | "private";

export interface ReconcileStorageAsset {
  id: string;
  storageKey?: string | null;
  storageBucket?: string | null;
  visibility: AssetVisibility;
}

export interface VisibilityBucketConfig {
  publicBucket: string;
  privateBucket: string;
}

export interface VisibilityObjectStore {
  copyObject(input: {
    sourceBucket: string;
    targetBucket: string;
    key: string;
  }): Promise<void>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  invalidatePublicObject(input: { key: string }): Promise<void>;
}

export interface ReconcileAssetStorageInput {
  asset: ReconcileStorageAsset;
  projectVisibility: AssetVisibility;
  previousEffectiveVisibility?: AssetVisibility;
  buckets?: VisibilityBucketConfig;
  store?: VisibilityObjectStore;
  persistStorageBucket: (storageBucket: string | null) => Promise<void>;
}

export interface ReconcileAssetStorageResult {
  effectiveVisibility: AssetVisibility;
  sourceBucket: string | null;
  targetBucket: string | null;
  moved: boolean;
  invalidated: boolean;
}

export function effectiveAssetVisibility(input: {
  assetVisibility: AssetVisibility;
  projectVisibility: AssetVisibility;
}): AssetVisibility {
  return input.assetVisibility === "public" && input.projectVisibility === "public"
    ? "public"
    : "private";
}

export function storageBucketForVisibility(
  visibility: AssetVisibility,
  buckets: VisibilityBucketConfig = storageBucketsFromEnv()
): string {
  return visibility === "public" ? buckets.publicBucket : buckets.privateBucket;
}

export async function reconcileAssetStorage(
  input: ReconcileAssetStorageInput
): Promise<ReconcileAssetStorageResult> {
  const buckets = input.buckets ?? storageBucketsFromEnv();
  const store = input.store ?? visibilityObjectStoreFromEnv();
  const storageKey = input.asset.storageKey ?? null;
  const effectiveVisibility = effectiveAssetVisibility({
    assetVisibility: input.asset.visibility,
    projectVisibility: input.projectVisibility,
  });
  const targetBucket = storageKey
    ? storageBucketForVisibility(effectiveVisibility, buckets)
    : null;
  const sourceBucket =
    input.asset.storageBucket ??
    (storageKey && input.previousEffectiveVisibility
      ? storageBucketForVisibility(input.previousEffectiveVisibility, buckets)
      : null);

  if (!storageKey) {
    await input.persistStorageBucket(null);
    return {
      effectiveVisibility,
      sourceBucket,
      targetBucket,
      moved: false,
      invalidated: false,
    };
  }

  if (!sourceBucket || !targetBucket) {
    throw new Error(
      `Cannot reconcile asset ${input.asset.id}: storage bucket is missing and no previous effective visibility was provided.`
    );
  }

  if (sourceBucket === targetBucket) {
    await input.persistStorageBucket(targetBucket ?? sourceBucket);
    return {
      effectiveVisibility,
      sourceBucket,
      targetBucket,
      moved: false,
      invalidated: false,
    };
  }

  await store.copyObject({ sourceBucket, targetBucket, key: storageKey });
  await input.persistStorageBucket(targetBucket);

  const invalidated = targetBucket === buckets.privateBucket;
  if (invalidated) {
    await store.invalidatePublicObject({ key: storageKey });
  }

  await store.deleteObject({ bucket: sourceBucket, key: storageKey });

  return {
    effectiveVisibility,
    sourceBucket,
    targetBucket,
    moved: true,
    invalidated,
  };
}

export function storageBucketsFromEnv(): VisibilityBucketConfig {
  return {
    publicBucket:
      process.env.S3_PUBLIC_BUCKET ||
      process.env.ASSETS_PUBLIC_BUCKET ||
      process.env.PUBLIC_ASSETS_BUCKET ||
      "assets-public",
    privateBucket:
      process.env.S3_PRIVATE_BUCKET ||
      process.env.ASSETS_PRIVATE_BUCKET ||
      process.env.PRIVATE_ASSETS_BUCKET ||
      "assets-private",
  };
}

export function visibilityObjectStoreFromEnv(): VisibilityObjectStore {
  if ((process.env.STORAGE_BACKEND ?? "local") !== "s3") {
    return noopVisibilityObjectStore;
  }
  return new S3VisibilityObjectStore();
}

export const noopVisibilityObjectStore: VisibilityObjectStore = {
  async copyObject() {},
  async deleteObject() {},
  async invalidatePublicObject() {},
};

class S3VisibilityObjectStore implements VisibilityObjectStore {
  private async s3Client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      endpoint: process.env.AWS_ENDPOINT_URL_S3 || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
  }

  async copyObject(input: {
    sourceBucket: string;
    targetBucket: string;
    key: string;
  }): Promise<void> {
    const { CopyObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3Client();
    await client.send(
      new CopyObjectCommand({
        Bucket: input.targetBucket,
        Key: input.key,
        CopySource: `${input.sourceBucket}/${encodeS3CopySourceKey(input.key)}`,
      })
    );
  }

  async deleteObject(input: { bucket: string; key: string }): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3Client();
    await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
  }

  async invalidatePublicObject(input: { key: string }): Promise<void> {
    const distributionId =
      process.env.CLOUDFRONT_DISTRIBUTION_ID ||
      process.env.CF_DISTRIBUTION_ID ||
      process.env.S3_PUBLIC_CLOUDFRONT_DISTRIBUTION_ID;
    if (!distributionId) return;

    const { CloudFrontClient, CreateInvalidationCommand } = await import(
      "@aws-sdk/client-cloudfront"
    );
    const client = new CloudFrontClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    await client.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: `asset-visibility-${Date.now()}-${randomUUID()}`,
          Paths: {
            Quantity: 1,
            Items: [`/${input.key.replace(/^\/+/, "")}`],
          },
        },
      })
    );
  }
}

function encodeS3CopySourceKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
