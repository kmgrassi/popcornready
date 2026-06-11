import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchBucket,
  NotFound,
  PutObjectCommand,
  type BucketLocationConstraint,
  type S3Client,
} from "@aws-sdk/client-s3";
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

export function createObjectStore(config: StorageConfig = readStorageConfig()): ObjectStore {
  if (config.backend === "local") return createLocalObjectStore(config);
  return createS3ObjectStore(config);
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

function encodeS3CopySourceKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isMissingBucket(error: unknown): boolean {
  return error instanceof NoSuchBucket || error instanceof NotFound;
}
