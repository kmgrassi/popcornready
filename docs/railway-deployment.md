# Railway deployment

This app deploys to Railway as a single Next.js web service. Railway's Railpack
builder can detect the Node app, run `npm run build`, and start it with
`npm run start`. The checked-in `railway.toml` pins those commands and configures
the existing health route.

## Pricing notes

Railway pricing has two parts:

- A monthly plan subscription.
- Metered resource usage for CPU, RAM, egress, and volume storage.

The paid plan subscription counts toward usage. For example, if the Hobby plan
is $5/month and the project uses less than $5 of resources, the bill remains the
plan minimum. Check Railway's pricing page before launch because plan limits and
resource prices can change.

For this app, expect usage from:

- The Next.js web service.
- Remotion export jobs, which temporarily use CPU and memory.
- Network egress for previews and MP4 downloads.
- Volume storage if you persist uploaded/generated media on Railway.

## Deploy from the Railway dashboard

1. Push this repository to GitHub.
2. In Railway, create a new project.
3. Choose **Deploy from GitHub repo** and select this repository.
4. Railway should detect the root app and use `railway.toml`.
5. Add the service variables listed below.
6. Deploy the service.
7. In the service **Networking** settings, generate a public Railway domain or
   attach a custom domain.

## Deploy from the Railway CLI

Install and authenticate the Railway CLI, then run:

```bash
railway init
railway up
```

For automated deploys, use a Railway project token rather than a personal
account token:

```bash
export RAILWAY_TOKEN="your-project-token"
railway up --ci
```

## Required service variables

Set these in the service **Variables** tab:

```bash
AUTH_MODE=local
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
```

Notes:

- Railway injects `PORT`; do not hard-code a port.
- Keep provider API keys server-only. Do not rename them with `NEXT_PUBLIC_`.
- `AUTH_MODE=local` is acceptable for a private demo. Hosted key-based auth is
  not implemented yet, so do not expose this as a multi-user production service
  without adding auth.

## Healthcheck

The Railway config uses:

```toml
healthcheckPath = "/api/v1/health"
```

Railway calls this path during deployment and only marks the new deployment
active once it returns HTTP 200.

## File storage limitation

The MVP currently stores project state and media on the local filesystem:

- `data/project.json`
- `public/uploads/`
- `public/generated/`
- `public/exports/`

Railway deployment filesystems are ephemeral unless a volume is attached. This
means uploaded clips, generated assets, exported MP4s, and the single-project
JSON store can be lost on redeploy or service migration.

For a short demo, ephemeral storage may be acceptable. For a hosted service,
move project state to a database and media to object storage. A temporary Railway
volume can reduce data loss, but the app is not yet parameterized to move all of
these directories under `RAILWAY_VOLUME_MOUNT_PATH`.

## Public API automation

Railway's public API is GraphQL at:

```text
https://backboard.railway.com/graphql/v2
```

Use an account or workspace token with:

```text
Authorization: Bearer <token>
```

Use a project token with:

```text
Project-Access-Token: <token>
```

Useful automation tasks for this app:

- Create or update service variables.
- Trigger `railway up` from CI with a project token.
- Generate or attach a service domain.
- Query deployment status and logs after deploy.

For most deploys, the CLI and GitHub integration are simpler than direct API
calls. Use the GraphQL API when you need repeatable infrastructure automation.

## Smoke test

After deployment, verify:

```bash
curl https://your-domain.example/api/v1/health
```

Expected response:

```json
{"status":"ok","authMode":"local","time":"..."}
```

Then open the public URL and create a small test project. MP4 export is the
heaviest path, so test at least one export before sharing the service.
