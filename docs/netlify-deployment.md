# Netlify deployment

Popcorn Ready deploys to Netlify as a Next.js app. Netlify detects Next.js
projects, builds with `npm run build`, publishes the `.next` output, and uses
the official Next.js runtime plugin for App Router pages, API routes, and server
rendering. The checked-in `netlify.toml` pins those settings so dashboard and
CLI deploys behave the same way.

## Deploy from the Netlify dashboard

1. Push this repository to GitHub.
2. In Netlify, create a new site.
3. Choose **Import an existing project** and connect the GitHub repo.
4. Confirm the build settings:
   - Build command: `npm run build`
   - Publish directory: `.next`
5. Add the environment variables listed below.
6. Deploy the site.
7. In **Domain management**, use the generated Netlify domain or attach the
   production custom domain.

## Deploy from the Netlify CLI

Install and authenticate the Netlify CLI, then run:

```bash
netlify init
netlify deploy --build
netlify deploy --build --prod
```

For CI, store `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` as CI secrets and run:

```bash
netlify deploy --build --prod
```

## Required environment variables

Set these in **Site configuration > Environment variables**:

```bash
AUTH_MODE=local
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ONESHOT_VIDEO=on
```

Notes:

- Keep provider API keys server-only. Do not rename them with `NEXT_PUBLIC_`.
- `AUTH_MODE=local` is acceptable for a private demo. Hosted key-based auth is
  not implemented yet, so do not expose this as a multi-user production service
  without adding auth.
- Netlify provides framework variables such as URL and deploy context. The app
  should still read its provider keys from the explicit variables above.

## Runtime limitations

The MVP currently stores project state and media on the local filesystem:

- `.local/`
- `public/uploads/`
- `public/generated/`
- `public/exports/`

Netlify function filesystems are ephemeral and are not shared durable storage.
Uploaded clips, generated assets, exported MP4s, and local JSON stores should
move to object storage and a database before this becomes a public hosted
service. S3-compatible object storage plus Postgres is the likely production
shape.

Video generation and Remotion rendering can also be long-running and CPU-heavy.
Use Netlify first for the landing page, studio UI, and private demos. For public
production rendering, move generation/export work to a queue-backed worker or a
dedicated render service, then have Netlify call that service from API routes.

## Smoke test

After deployment, verify the API health route:

```bash
curl https://your-site.netlify.app/api/v1/health
```

Expected response:

```json
{"status":"ok","authMode":"local","time":"..."}
```

Then open the public URL and create a small test project. MP4 export is the
heaviest path, so test at least one export before sharing the service.
