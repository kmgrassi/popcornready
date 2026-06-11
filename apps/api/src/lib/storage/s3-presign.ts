import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readStorageConfig, type StorageConfig } from "./config";
import { getS3Client } from "./s3-client";

export async function buildPresignedS3Url(
  input: {
    bucket: string;
    key: string;
    expiresInSec?: number;
  },
  client: S3Client = getS3Client()
): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
    }),
    { expiresIn: input.expiresInSec ?? 300 }
  );
}

export function parseS3ObjectFromUrl(
  url: string,
  config: StorageConfig = readStorageConfig()
): { bucket: string; key: string } | null {
  const parsed = new URL(url);
  const endpoint = config.s3EndpointUrl ? new URL(config.s3EndpointUrl) : null;

  if (endpoint && parsed.host === endpoint.host) {
    const [bucket, ...keyParts] = parsed.pathname.replace(/^\/+/, "").split("/");
    if (bucket && keyParts.length > 0) {
      return { bucket, key: decodeURIComponent(keyParts.join("/")) };
    }
  }

  const virtualHostSuffix = `.s3.${config.region}.amazonaws.com`;
  if (parsed.hostname.endsWith(virtualHostSuffix)) {
    const bucket = parsed.hostname.slice(0, -virtualHostSuffix.length);
    const key = parsed.pathname.replace(/^\/+/, "");
    if (bucket && key) return { bucket, key: decodeURIComponent(key) };
  }

  return null;
}

export async function buildPresignedS3UrlFromPublicUrl(
  url: string,
  config: StorageConfig = readStorageConfig(),
  client: S3Client = getS3Client(config)
): Promise<string | null> {
  const object = parseS3ObjectFromUrl(url, config);
  if (!object) return null;
  return buildPresignedS3Url(object, client);
}
