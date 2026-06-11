import {
  CopyObjectCommand,
  CreateBucketCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchBucket,
  NotFound,
  PutObjectCommand,
  S3ServiceException,
  UploadPartCommand,
  type BucketLocationConstraint,
  type CompletedPart,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { canSignCloudFront, signCloudFrontUrl } from "./cloudfront";
import {
  readStorageConfig,
  resolveBucket,
  type AssetVisibility,
  type StorageConfig,
} from "./config";
import { createLocalObjectStore } from "./local-store";
import { buildPresignedS3Url } from "./s3-presign";
import { getS3Client } from "./s3-client";

export type ObjectBody = Buffer | Uint8Array | string;

export interface PutObjectInput {
  key: string;
  body: ObjectBody;
  visibility: AssetVisibility;
  contentType?: string;
}

export interface CopyObjectInput {
  sourceKey: string;
  sourceVisibility: AssetVisibility;
  destinationKey: string;
  destinationVisibility: AssetVisibility;
  contentType?: string;
}

export interface StoredObject {
  body: Buffer;
  contentType?: string;
}

export interface ObjectStore {
  putObject(input: PutObjectInput): Promise<{ bucket: string; key: string }>;
  getObject(key: string, visibility: AssetVisibility): Promise<StoredObject>;
  copyObject(input: CopyObjectInput): Promise<{ bucket: string; key: string }>;
  deleteObject(key: string, visibility: AssetVisibility): Promise<void>;
  objectUrl(key: string, visibility: AssetVisibility): string;
  signedObjectUrl(key: string, visibility: AssetVisibility, expiresInSec?: number): Promise<string>;
  ensureBucket(visibility: AssetVisibility): Promise<void>;
}

export interface S3ObjectStoreDeps {
  client?: S3Client;
  signCloudFrontUrl?: typeof signCloudFrontUrl;
  buildPresignedS3Url?: typeof buildPresignedS3Url;
}

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

export function createObjectStore(config: StorageConfig = readStorageConfig()): ObjectStore {
  if (config.backend === "local") return createLocalObjectStore(config);
  return createS3ObjectStore(config);
}

export async function createPresignedPutTarget(input: {
  visibility: AssetVisibility;
  key: string;
  contentType: string;
  config?: StorageConfig;
}): Promise<PresignedPutTarget> {
  const config = input.config ?? readStorageConfig();
  const command = new PutObjectCommand({
    Bucket: resolveBucket(config, input.visibility),
    Key: input.key,
    ContentType: input.contentType,
  });
  const url = await getSignedUrl(getS3Client(config), command, {
    expiresIn: config.presignTtlSeconds,
  });
  return {
    url,
    headers: { "content-type": input.contentType },
    expiresAt: expiresAt(config.presignTtlSeconds),
  };
}

export async function createMultipartUploadTarget(input: {
  visibility: AssetVisibility;
  key: string;
  contentType: string;
  sizeBytes: number;
  config?: StorageConfig;
}): Promise<MultipartUploadTarget> {
  const config = input.config ?? readStorageConfig();
  const client = getS3Client(config);
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: resolveBucket(config, input.visibility),
      Key: input.key,
      ContentType: input.contentType,
    })
  );
  if (!created.UploadId) throw new Error("S3 did not return a multipart upload id.");

  const partCount = Math.ceil(input.sizeBytes / config.multipartPartSizeBytes);
  if (partCount > 10_000) {
    throw new Error("Upload is too large for the configured multipart part size.");
  }

  const parts: PresignedUploadPart[] = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const command = new UploadPartCommand({
      Bucket: resolveBucket(config, input.visibility),
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
  visibility: AssetVisibility;
  key: string;
  uploadId: string;
  parts: CompletedPart[];
  config?: StorageConfig;
}): Promise<void> {
  const config = input.config ?? readStorageConfig();
  await getS3Client(config).send(
    new CompleteMultipartUploadCommand({
      Bucket: resolveBucket(config, input.visibility),
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
  visibility: AssetVisibility;
  key: string;
  config?: StorageConfig;
}): Promise<boolean> {
  const config = input.config ?? readStorageConfig();
  try {
    await getS3Client(config).send(
      new HeadObjectCommand({
        Bucket: resolveBucket(config, input.visibility),
        Key: input.key,
      })
    );
    return true;
  } catch (error) {
    if (error instanceof NoSuchBucket || error instanceof NotFound) return false;
    const name = error instanceof Error ? error.name : "";
    if (name === "NotFound" || name === "NoSuchKey") return false;
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

export function createS3ObjectStore(
  config: StorageConfig = readStorageConfig(),
  deps: S3ObjectStoreDeps = {}
): ObjectStore {
  const client = deps.client ?? getS3Client(config);
  const cloudFrontSigner = deps.signCloudFrontUrl ?? signCloudFrontUrl;
  const s3Presigner = deps.buildPresignedS3Url ?? buildPresignedS3Url;

  return {
    async putObject(input) {
      const bucket = resolveBucket(config, input.visibility);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        })
      );
      return { bucket, key: input.key };
    },

    async getObject(key, visibility) {
      const bucket = resolveBucket(config, visibility);
      const response = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      const body = response.Body
        ? Buffer.from(await response.Body.transformToByteArray())
        : Buffer.alloc(0);
      return {
        body,
        contentType: response.ContentType,
      };
    },

    async copyObject(input) {
      const sourceBucket = resolveBucket(config, input.sourceVisibility);
      const destinationBucket = resolveBucket(config, input.destinationVisibility);
      await client.send(
        new CopyObjectCommand({
          Bucket: destinationBucket,
          Key: input.destinationKey,
          CopySource: `${sourceBucket}/${encodeS3CopySourceKey(input.sourceKey)}`,
          ContentType: input.contentType,
          MetadataDirective: input.contentType ? "REPLACE" : undefined,
        })
      );
      return { bucket: destinationBucket, key: input.destinationKey };
    },

    async deleteObject(key, visibility) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: resolveBucket(config, visibility),
          Key: key,
        })
      );
    },

    objectUrl(key) {
      return joinUrl(config.publicUrlBase, key);
    },

    async signedObjectUrl(key, visibility, expiresInSec = 300) {
      const unsignedUrl = this.objectUrl(key, visibility);
      if (canSignCloudFront(config)) {
        try {
          return cloudFrontSigner(unsignedUrl, expiresInSec, config);
        } catch {
          // Fall through to S3 presign. The storage layer must keep reads working
          // when CloudFront signing is absent or misconfigured in local/staging.
        }
      }

      try {
        return await s3Presigner(
          {
            bucket: resolveBucket(config, visibility),
            key,
            expiresInSec,
          },
          client
        );
      } catch {
        return unsignedUrl;
      }
    },

    async ensureBucket(visibility) {
      const bucket = resolveBucket(config, visibility);
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return;
      } catch (error) {
        if (!isMissingBucket(error)) throw error;
      }

      await client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          CreateBucketConfiguration:
            config.region === "us-east-1"
              ? undefined
              : { LocationConstraint: config.region as BucketLocationConstraint },
        })
      );
    },
  };
}

function joinUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

function expiresAt(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function encodeS3CopySourceKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isMissingBucket(error: unknown): boolean {
  return error instanceof NoSuchBucket || error instanceof NotFound;
}
