# Asset Sharing Manual Test

Use this flow after the storage foundation, write path, read path, and
visibility-reconcile PRs are present. It verifies the same lifecycle as
`apps/api/scripts/storage-smoke.ts`: create an asset, publish it, fetch it
without credentials, privatize it, and confirm only a signed owner URL works.

## Local MinIO Setup

Start MinIO from the repository root:

```sh
docker compose -f docker-compose.minio.yml up -d
```

Run the API with the S3 backend pointed at MinIO:

```sh
STORAGE_BACKEND=s3 \
AUTH_MODE=local \
AWS_REGION=us-east-1 \
AWS_ENDPOINT_URL_S3=http://localhost:9000 \
S3_FORCE_PATH_STYLE=true \
S3_PUBLIC_BUCKET=assets-public \
S3_PRIVATE_BUCKET=assets-private \
S3_PUBLIC_URL_BASE=http://localhost:9000/assets-public \
AWS_ACCESS_KEY_ID=minioadmin \
AWS_SECRET_ACCESS_KEY=minioadmin \
pnpm --filter @popcorn/api dev
```

If the public and private buckets do not already exist, create them in the
MinIO console before running the test. The default console is usually
`http://localhost:9001`.

## Automated Smoke

With the API running:

```sh
pnpm --filter @popcorn/api storage:smoke
```

Useful overrides:

```sh
STORAGE_SMOKE_API_BASE_URL=http://localhost:4000/api/v1 \
STORAGE_SMOKE_SOURCE_MODE=multipart \
STORAGE_SMOKE_PUBLIC_STATUS=200 \
STORAGE_SMOKE_PRIVATE_STATUS=403 \
pnpm --filter @popcorn/api storage:smoke
```

For a Supabase-authenticated staging environment, add
`STORAGE_SMOKE_AUTH_TOKEN=<access-token>` and point
`STORAGE_SMOKE_API_BASE_URL` at the deployed `/api/v1` URL.

## Curl Walkthrough

Create a project:

```sh
curl -sS -X POST http://localhost:4000/api/v1/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Asset sharing manual test"}'
```

Save the returned `project.id` as `PROJECT_ID`.

Register an uploaded asset:

```sh
PNG_BASE64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

curl -sS -X POST "http://localhost:4000/api/v1/projects/$PROJECT_ID/assets" \
  -H 'content-type: application/json' \
  -d "{
    \"source\": {
      \"type\": \"multipart_upload\",
      \"dataBase64\": \"$PNG_BASE64\",
      \"mimeType\": \"image/png\"
    },
    \"kind\": \"image\",
    \"filename\": \"asset-sharing-manual.png\"
  }"
```

Save the returned `asset.id` as `ASSET_ID`. Confirm the response includes
`storageKey` and `storageBucket`, then confirm the object exists in MinIO under
the key pattern `{workspace}/{project}/{assetId}/...`.

Publish the asset:

```sh
curl -sS -X PATCH \
  "http://localhost:4000/api/v1/projects/$PROJECT_ID/assets/$ASSET_ID/visibility" \
  -H 'content-type: application/json' \
  -d '{"visibility":"public"}'
```

Confirm the object moved to `assets-public`. Then fetch public discovery without
an auth header:

```sh
curl -sS 'http://localhost:4000/api/v1/discover/assets?limit=100'
```

Find `ASSET_ID` in the response and save its media URL as `PUBLIC_URL`. It
should be a stable URL under `S3_PUBLIC_URL_BASE`.

Open the public URL:

```sh
curl -i "$PUBLIC_URL"
```

The response should be `HTTP/1.1 200`.

Privatize the asset:

```sh
curl -sS -X PATCH \
  "http://localhost:4000/api/v1/projects/$PROJECT_ID/assets/$ASSET_ID/visibility" \
  -H 'content-type: application/json' \
  -d '{"visibility":"private"}'
```

The object should move back to `assets-private`. The old public URL should no
longer resolve:

```sh
curl -i "$PUBLIC_URL"
```

Expected response is `403` locally. In staging or production, also confirm a
CloudFront invalidation was created for the privatized key.

Fetch the owner asset response and verify the signed URL works:

```sh
curl -sS "http://localhost:4000/api/v1/projects/$PROJECT_ID/assets/$ASSET_ID"
```

Save the returned signed media URL as `SIGNED_URL` and run:

```sh
curl -i "$SIGNED_URL"
```

The response should be `HTTP/1.1 200`, and the URL should expire after roughly
five minutes.

## Project Visibility Cascade

After the project visibility route lands, repeat the same lifecycle at project
scope:

```sh
curl -sS -X PATCH "http://localhost:4000/api/v1/projects/$PROJECT_ID" \
  -H 'content-type: application/json' \
  -d '{"visibility":"public"}'

curl -sS -X PATCH "http://localhost:4000/api/v1/projects/$PROJECT_ID" \
  -H 'content-type: application/json' \
  -d '{"visibility":"private"}'
```

Republishing the project should restore the exact set of assets that were
effectively public before the project was privatized. Asset-level visibility
flags should not be rewritten by the project cascade.
