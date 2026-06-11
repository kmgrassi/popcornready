import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  physicalBucketName,
  readStorageConfig,
  type AssetStorageBucket,
} from "./config";
import { getS3Client } from "./s3-client";

export interface PresignedPutTarget {
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface PresignedUploadPart {
  partNumber: number;
  url: string;
}

export interface MultipartUploadTarget {
  uploadId: string;
  partSizeBytes: number;
  parts: PresignedUploadPart[];
  expiresAt: string;
}

function expiresAt(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

export async function createPresignedPutTarget(input: {
  bucket: AssetStorageBucket;
  key: string;
  contentType: string;
}): Promise<PresignedPutTarget> {
  const config = readStorageConfig();
  const client = getS3Client();
  const putCommand = new PutObjectCommand({
    Bucket: physicalBucketName(input.bucket, config),
    Key: input.key,
    ContentType: input.contentType,
  });
  const url = await getSignedUrl(client, putCommand, {
    expiresIn: config.presignTtlSeconds,
  });
  return {
    url,
    headers: { "content-type": input.contentType },
    expiresAt: expiresAt(config.presignTtlSeconds),
  };
}

export async function createPresignedGetUrl(input: {
  bucket: AssetStorageBucket;
  key: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const config = readStorageConfig();
  const command = new GetObjectCommand({
    Bucket: physicalBucketName(input.bucket, config),
    Key: input.key,
  });
  return getSignedUrl(getS3Client(), command, {
    expiresIn: input.expiresInSeconds ?? config.presignTtlSeconds,
  });
}

export async function createMultipartUploadTarget(input: {
  bucket: AssetStorageBucket;
  key: string;
  contentType: string;
  sizeBytes: number;
}): Promise<MultipartUploadTarget> {
  const config = readStorageConfig();
  const client = getS3Client();
  const bucket = physicalBucketName(input.bucket, config);
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: input.key,
      ContentType: input.contentType,
    })
  );
  if (!created.UploadId) {
    throw new Error("S3 did not return a multipart upload id.");
  }

  const partCount = Math.ceil(input.sizeBytes / config.multipartPartSizeBytes);
  if (partCount > 10_000) {
    throw new Error("Upload is too large for the configured multipart part size.");
  }

  const parts: PresignedUploadPart[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const command = new UploadPartCommand({
      Bucket: bucket,
      Key: input.key,
      UploadId: created.UploadId,
      PartNumber: partNumber,
    });
    parts.push({
      partNumber,
      url: await getSignedUrl(client, command, {
        expiresIn: config.presignTtlSeconds,
      }),
    });
  }

  return {
    uploadId: created.UploadId,
    partSizeBytes: config.multipartPartSizeBytes,
    parts,
    expiresAt: expiresAt(config.presignTtlSeconds),
  };
}

export async function completeMultipartUpload(input: {
  bucket: AssetStorageBucket;
  key: string;
  uploadId: string;
  parts: CompletedPart[];
}): Promise<void> {
  const config = readStorageConfig();
  const client = getS3Client();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: physicalBucketName(input.bucket, config),
      Key: input.key,
      UploadId: input.uploadId,
      MultipartUpload: {
        Parts: [...input.parts].sort(
          (a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0)
        ),
      },
    })
  );
}

export async function objectExists(input: {
  bucket: AssetStorageBucket;
  key: string;
}): Promise<boolean> {
  const config = readStorageConfig();
  const client = getS3Client();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: physicalBucketName(input.bucket, config),
        Key: input.key,
      })
    );
    return true;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotFound" || name === "NoSuchKey") {
      return false;
    }
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}
