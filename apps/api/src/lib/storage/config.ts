export type StorageVisibility = "public" | "private";

export interface StorageConfig {
  backend: "local" | "s3";
  publicBucket: string;
  privateBucket: string;
}

export function storageConfig(): StorageConfig {
  return {
    backend: process.env.STORAGE_BACKEND === "s3" ? "s3" : "local",
    publicBucket: process.env.S3_PUBLIC_BUCKET || "assets-public",
    privateBucket: process.env.S3_PRIVATE_BUCKET || "assets-private",
  };
}

export function bucketForVisibility(visibility: StorageVisibility): string {
  const config = storageConfig();
  return visibility === "public" ? config.publicBucket : config.privateBucket;
}
