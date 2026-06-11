import { S3Client } from "@aws-sdk/client-s3";
import { readStorageConfig, type StorageConfig } from "./config";

let cachedClient: S3Client | null = null;
let cachedSignature = "";

export function getS3Client(config: StorageConfig = readStorageConfig()): S3Client {
  const signature = [
    config.region,
    config.s3EndpointUrl ?? "",
    config.forcePathStyle ? "path" : "virtual",
  ].join("|");

  if (cachedClient && cachedSignature === signature) return cachedClient;

  cachedClient = new S3Client({
    region: config.region,
    endpoint: config.s3EndpointUrl,
    forcePathStyle: config.forcePathStyle,
  });
  cachedSignature = signature;
  return cachedClient;
}

export function resetS3ClientForTests(): void {
  cachedClient = null;
  cachedSignature = "";
}
