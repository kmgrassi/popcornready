import { S3Client } from "@aws-sdk/client-s3";
import { readStorageConfig } from "./config";

let cachedClient: S3Client | null = null;
let cachedKey = "";

export function getS3Client(env: NodeJS.ProcessEnv = process.env): S3Client {
  const config = readStorageConfig(env);
  const key = [
    config.region,
    config.endpointUrl ?? "",
    config.forcePathStyle ? "path" : "virtual",
  ].join("|");
  if (cachedClient && cachedKey === key) return cachedClient;

  cachedClient = new S3Client({
    region: config.region,
    endpoint: config.endpointUrl,
    forcePathStyle: config.forcePathStyle,
  });
  cachedKey = key;
  return cachedClient;
}
