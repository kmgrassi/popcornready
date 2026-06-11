import { promises as fs } from "node:fs";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { localDir } from "@/lib/api/v1/store";
import { storageConfig } from "./config";

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}

export interface ObjectStore {
  putObject(input: PutObjectInput): Promise<void>;
}

class LocalObjectStore implements ObjectStore {
  async putObject(input: PutObjectInput): Promise<void> {
    void input.bucket;
    const destPath = path.join(localDir(), input.key);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, input.body);
  }
}

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (s3Client) return s3Client;
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  s3Client = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
  return s3Client;
}

class S3ObjectStore implements ObjectStore {
  async putObject(input: PutObjectInput): Promise<void> {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      })
    );
  }
}

const localStore = new LocalObjectStore();
const s3Store = new S3ObjectStore();

export function objectStore(): ObjectStore {
  return storageConfig().backend === "s3" ? s3Store : localStore;
}
