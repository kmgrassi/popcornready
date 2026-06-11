import { promises as fs } from "node:fs";
import path from "node:path";
import {
  resolveBucket,
  type AssetVisibility,
  type StorageConfig,
} from "./config";
import type { CopyObjectInput, ObjectStore, PutObjectInput, StoredObject } from "./object-store";

export function createLocalObjectStore(config: StorageConfig): ObjectStore {
  return {
    async putObject(input: PutObjectInput) {
      const bucket = resolveBucket(config, input.visibility);
      const target = objectPath(config, bucket, input.key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, toBuffer(input.body));
      if (input.contentType) {
        await writeMetadata(target, { contentType: input.contentType });
      }
      return { bucket, key: input.key };
    },

    async getObject(key: string, visibility: AssetVisibility): Promise<StoredObject> {
      const bucket = resolveBucket(config, visibility);
      const target = objectPath(config, bucket, key);
      const [body, metadata] = await Promise.all([
        fs.readFile(target),
        readMetadata(target),
      ]);
      return { body, contentType: metadata.contentType };
    },

    async copyObject(input: CopyObjectInput) {
      const sourceBucket = resolveBucket(config, input.sourceVisibility);
      const destinationBucket = resolveBucket(config, input.destinationVisibility);
      const source = objectPath(config, sourceBucket, input.sourceKey);
      const destination = objectPath(config, destinationBucket, input.destinationKey);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);

      const metadata = input.contentType
        ? { contentType: input.contentType }
        : await readMetadata(source);
      if (metadata.contentType) await writeMetadata(destination, metadata);
      return { bucket: destinationBucket, key: input.destinationKey };
    },

    async deleteObject(key: string, visibility: AssetVisibility) {
      const bucket = resolveBucket(config, visibility);
      await fs.rm(objectPath(config, bucket, key), { force: true });
      await fs.rm(metadataPath(objectPath(config, bucket, key)), { force: true });
    },

    objectUrl(key: string) {
      return `/media/${key.replace(/^\/+/, "")}`;
    },

    async signedObjectUrl(key: string, visibility: AssetVisibility) {
      return this.objectUrl(key, visibility);
    },

    async ensureBucket(visibility: AssetVisibility) {
      const bucket = resolveBucket(config, visibility);
      await fs.mkdir(path.join(config.localMediaDir, bucket), { recursive: true });
    },
  };
}

function objectPath(config: StorageConfig, bucket: string, key: string): string {
  return path.join(config.localMediaDir, bucket, key);
}

function metadataPath(filePath: string): string {
  return `${filePath}.metadata.json`;
}

function toBuffer(body: Buffer | Uint8Array | string): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

async function readMetadata(filePath: string): Promise<{ contentType?: string }> {
  try {
    return JSON.parse(await fs.readFile(metadataPath(filePath), "utf8")) as {
      contentType?: string;
    };
  } catch {
    return {};
  }
}

async function writeMetadata(
  filePath: string,
  metadata: { contentType?: string }
): Promise<void> {
  await fs.writeFile(metadataPath(filePath), JSON.stringify(metadata), "utf8");
}
