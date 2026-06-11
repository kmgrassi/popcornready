export type StorageBackend = "local" | "s3";
export type AssetStorageBucket = "assets-public" | "assets-private";
export type AssetVisibility = "public" | "private";

export interface StorageConfig {
  backend: StorageBackend;
  region: string;
  endpointUrl?: string;
  forcePathStyle: boolean;
  publicBucket: string;
  privateBucket: string;
  publicUrlBase?: string;
  presignTtlSeconds: number;
  multipartThresholdBytes: number;
  multipartPartSizeBytes: number;
}

function optionalEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function positiveIntegerEnv(
  name: string,
  env: NodeJS.ProcessEnv,
  fallback: number
): number {
  const raw = optionalEnv(name, env);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(name: string, env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes)$/i.test(optionalEnv(name, env) ?? "");
}

export function readStorageConfig(
  env: NodeJS.ProcessEnv = process.env
): StorageConfig {
  const backend =
    optionalEnv("STORAGE_BACKEND", env) === "s3" ? "s3" : "local";
  return {
    backend,
    region: optionalEnv("AWS_REGION", env) ?? "us-east-1",
    endpointUrl: optionalEnv("AWS_ENDPOINT_URL_S3", env),
    forcePathStyle: boolEnv("S3_FORCE_PATH_STYLE", env),
    publicBucket: optionalEnv("S3_PUBLIC_BUCKET", env) ?? "assets-public",
    privateBucket: optionalEnv("S3_PRIVATE_BUCKET", env) ?? "assets-private",
    publicUrlBase: optionalEnv("S3_PUBLIC_URL_BASE", env)?.replace(/\/+$/, ""),
    presignTtlSeconds: positiveIntegerEnv("S3_PRESIGN_TTL_SECONDS", env, 900),
    multipartThresholdBytes: positiveIntegerEnv(
      "S3_MULTIPART_THRESHOLD_BYTES",
      env,
      100 * 1024 * 1024
    ),
    multipartPartSizeBytes: Math.max(
      5 * 1024 * 1024,
      positiveIntegerEnv("S3_MULTIPART_PART_SIZE_BYTES", env, 64 * 1024 * 1024)
    ),
  };
}

export function storageBucketForVisibility(
  visibility: AssetVisibility
): AssetStorageBucket {
  return visibility === "public" ? "assets-public" : "assets-private";
}

export function physicalBucketName(
  logicalBucket: AssetStorageBucket,
  config: StorageConfig = readStorageConfig()
): string {
  return logicalBucket === "assets-public"
    ? config.publicBucket
    : config.privateBucket;
}
