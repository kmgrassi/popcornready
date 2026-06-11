import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { readStorageConfig, type StorageConfig } from "./config";

export function canSignCloudFront(config: StorageConfig = readStorageConfig()): boolean {
  return Boolean(config.cloudFrontKeyPairId && config.cloudFrontPrivateKey);
}

export function signCloudFrontUrl(
  url: string,
  expiresInSec = 300,
  config: StorageConfig = readStorageConfig()
): string {
  if (!config.cloudFrontKeyPairId || !config.cloudFrontPrivateKey) {
    throw new Error("CloudFront signing is not configured.");
  }

  return getSignedUrl({
    url,
    keyPairId: config.cloudFrontKeyPairId,
    privateKey: config.cloudFrontPrivateKey,
    dateLessThan: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  });
}
