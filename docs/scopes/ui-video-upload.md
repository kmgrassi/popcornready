# UI Video Upload Scope

## Objective

Make browser-based upload reliable enough for production operators to bring in
multiple source videos, understand whether each asset is usable, and manage the
clip catalog before generation.

## User Workflow

1. Create or open a project.
2. Drag files into an upload area or choose files from the file picker.
3. See per-file progress, validation, and processing state.
4. Review uploaded clips in an asset list with thumbnails, duration, dimensions,
   file size, codec, and readiness status.
5. Add or edit clip context before generation.
6. Remove, replace, or mark clips as required/optional.

## Required Features

- Multi-file upload with progress per file.
- Client-side preflight checks for file type and size.
- Server-side validation for MIME type, extension, duration, dimensions, and
  readable video streams.
- Server-side duration extraction; clients should not submit authoritative
  duration values.
- Local-path assets provided by local agents are copied into managed local media
  storage before processing, so source files are never mutated or depended on in
  place.
- Upload cancellation and retry.
- Duplicate detection by checksum or asset fingerprint.
- Thumbnail generation for quick visual review.
- Upload status states: `queued`, `uploading`, `processing`, `ready`, `failed`.
- Error messages that identify actionable failures: unsupported type, too large,
  unreadable media, processing failure, storage failure.

## Suggested Data Model

```ts
type AssetStatus = "queued" | "uploading" | "processing" | "ready" | "failed";

interface VideoAsset {
  id: string;
  projectId: string;
  originalFilename: string;
  storageUrl: string;
  thumbnailUrl?: string;
  durationSec: number;
  width: number;
  height: number;
  fps?: number;
  codec?: string;
  fileSizeBytes: number;
  checksum?: string;
  status: AssetStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

## UI Requirements

- Upload area supports drag-and-drop and file picker.
- Asset list supports compact scanning: thumbnail, filename, duration, status,
  context completeness, and actions.
- Clip detail panel supports metadata review and context entry.
- Generation controls remain disabled until at least one ready clip exists.
- If an upload fails, the failed item remains visible with retry/remove actions.

## API Implications

- `POST /api/projects/:projectId/assets/upload-url` for direct-to-storage upload
  in production.
- `POST /api/projects/:projectId/assets` to register uploaded media.
- `GET /api/projects/:projectId/assets` to list assets and processing status.
- `DELETE /api/projects/:projectId/assets/:assetId` to remove an asset.

The current MVP can keep multipart upload for local development, but production
should use object storage and signed URLs to avoid routing large files through
the web process.

## Acceptance Criteria

- A user can upload at least 10 clips in one project and recover from one failed
  upload without losing the other clips.
- The backend rejects invalid media even if the client bypasses browser checks.
- Uploaded clips show accurate duration and preview metadata without user input.
- The upload flow does not expose local filesystem paths or secrets in logs.
