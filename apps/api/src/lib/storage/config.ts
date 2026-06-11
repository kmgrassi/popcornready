import path from "node:path";

export type StorageBackend = "local" | "s3";
export type AssetVisibility = "public" | "private";

export interface StorageConfig {
  backend: StorageBackend;
  localMediaDir: string;
  region: string;
  publicBucket: string;
  privateBucket: string;
  publicUrlBase: string;
  cloudFrontKeyPairId?: string;
  cloudFrontPrivateKey?: string;
  s3EndpointUrl?: string;
  forcePathStyle: boolean;
}

export class StorageConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `S3 storage is not configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } required when STORAGE_BACKEND=s3.`
    );
    this.name = "StorageConfigError";
  }
}

export function readStorageConfig(
  env: NodeJS.ProcessEnv = process.env
): StorageConfig {
  const backend = readBackend(env.STORAGE_BACKEND);
  const config: StorageConfig = {
    backend,
    localMediaDir:
      trim(env.STORAGE_LOCAL_DIR) ||
      path.join(trim(env.POPCORN_READY_LOCAL_DIR) || path.join(process.cwd(), ".local"), "media"),
    region: trim(env.AWS_REGION) || "us-east-1",
    publicBucket: trim(env.S3_PUBLIC_BUCKET) || "assets-public",
    privateBucket: trim(env.S3_PRIVATE_BUCKET) || "assets-private",
    publicUrlBase: trim(env.S3_PUBLIC_URL_BASE).replace(/\/+$/, ""),
    cloudFrontKeyPairId: trim(env.CF_SIGN_KEY_PAIR_ID) || undefined,
    cloudFrontPrivateKey: normalizePrivateKey(trim(env.CF_SIGN_PRIVATE_KEY)) || undefined,
    s3EndpointUrl: trim(env.AWS_ENDPOINT_URL_S3) || undefined,
    forcePathStyle: parseBoolean(env.S3_FORCE_PATH_STYLE),
  };

  if (backend === "s3") validateS3Config(config, env);
  return config;
}

export function resolveBucket(
  config: Pick<StorageConfig, "publicBucket" | "privateBucket">,
  visibility: AssetVisibility
): string {
  return visibility === "public" ? config.publicBucket : config.privateBucket;
}

export function visibilityForBucket(
  config: Pick<StorageConfig, "publicBucket" | "privateBucket">,
  bucket: string
): AssetVisibility {
  if (bucket === config.publicBucket) return "public";
  if (bucket === config.privateBucket) return "private";
  throw new Error(`Unknown asset storage bucket: ${bucket}`);
}

function readBackend(value: string | undefined): StorageBackend {
  const normalized = trim(value).toLowerCase();
  if (!normalized || normalized === "local") return "local";
  if (normalized === "s3") return "s3";
  throw new Error(`Unsupported STORAGE_BACKEND "${value}". Expected "local" or "s3".`);
}

function validateS3Config(config: StorageConfig, env: NodeJS.ProcessEnv): void {
  const missing: string[] = [];
  if (!config.region) missing.push("AWS_REGION");
  if (!config.publicBucket) missing.push("S3_PUBLIC_BUCKET");
  if (!config.privateBucket) missing.push("S3_PRIVATE_BUCKET");
  if (!config.publicUrlBase) missing.push("S3_PUBLIC_URL_BASE");

  const hasStaticCredentials =
    Boolean(trim(env.AWS_ACCESS_KEY_ID)) && Boolean(trim(env.AWS_SECRET_ACCESS_KEY));
  const hasEndpoint = Boolean(config.s3EndpointUrl);
  if (!hasStaticCredentials && !hasEndpoint) {
    missing.push("AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or instance credentials");
  }

  if (missing.length > 0) throw new StorageConfigError(missing);
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(trim(value).toLowerCase());
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function trim(value: string | undefined): string {
  return (value ?? "").trim();
}
