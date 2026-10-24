# Set up HorizonScribe in your own Cloudflare account

This guide creates a new, isolated deployment. It does not require the author's infrastructure, photographs, login service, domain, or R2 credentials. Commands that create a bucket, put a secret, deploy, or upload objects affect **your Cloudflare account**. Other preparation commands only write local files.

## 1. Prepare the account and computer

1. Sign in to your own [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Select the intended account. Enable **R2 Object Storage** and complete any billing activation requested by Cloudflare. Do not assume all usage is free; consult current [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
3. Install Node.js 22.12+ and Git. Clone this repository and run `npm ci` from its root.
4. Authenticate Wrangler and inspect the selected identity:

```shell
npx wrangler login
npx wrangler whoami
```

The browser login authorizes Wrangler on this computer. It is different from the app's API token and from optional R2 S3 credentials. If several accounts are listed, add the chosen `account_id` to your generated Wrangler config before deploying.

Official reference: [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).

## 2. Choose isolated resource names

```shell
node scripts/configure-cloudflare.mjs --worker horizon-scribe --bucket horizon-scribe
```

This writes **ignored** `cloudflare/wrangler.jsonc`. It does not contact Cloudflare. The generator refuses to overwrite an existing config unless you explicitly pass `--force`. Keep a backup before choosing that option.

If you already use these names, choose different ones, for example `horizon-scribe-demo` and `horizon-scribe-demo-data`. Use the exact bucket name in every upload command. Worker and bucket names can differ.

Inspect your generated file:

| Setting | Default | Meaning |
| --- | --- | --- |
| `name` | `horizon-scribe` | Worker service in your account |
| `workers_dev` | `true` | Cloudflare-provided HTTPS hostname; no purchased domain required |
| `r2_buckets[0].binding` | `HORIZON_SCRIBE_BUCKET` | Code-facing binding; do not rename without changing code |
| `r2_buckets[0].bucket_name` | `horizon-scribe` | Your actual private R2 bucket |
| `vars.HORIZON_SCRIBE_PREFIX` | `production/horizon-scribe/v1` | Namespace shared by Worker, dataset builder, and S3 uploader |
| `vars.ALLOWED_ORIGINS` | empty | Extra trusted HTTPS browser origins; unnecessary for the native app/local reviewer |

The config contains no API token. A Worker accesses R2 through its binding, not an embedded S3 secret. See [R2 bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## 3. Create the private bucket

```shell
npx wrangler r2 bucket create horizon-scribe
```

Alternatively, create it under R2 in the dashboard and use the identical name in the config. Do not recreate an existing bucket merely to follow the tutorial.

Leave **Public Development URL** disabled and do not attach a public domain directly to the bucket. Photos are served through the authenticated Worker; public bucket access would bypass the app's authorization. A private bucket does not require browser CORS configuration for this architecture.

Official references: [Create a bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/) and [public bucket access](https://developers.cloudflare.com/r2/buckets/public-buckets/).

## 4. Create the app token — off camera

The random app token grants all implemented API permissions within this deployment. Keep it in a password manager. Do not commit it, put it in a URL, paste it into a public issue, or show it in a recording.

PowerShell:

```powershell
$HorizonScribeToken = (node .\scripts\create-api-token.mjs).Trim()
$HorizonScribeToken | npx wrangler secret put HORIZON_SCRIBE_API_TOKEN --config .\cloudflare\wrangler.jsonc
```

macOS/Linux shell:

```shell
HORIZON_SCRIBE_TOKEN="$(node scripts/create-api-token.mjs)"
printf '%s' "$HORIZON_SCRIBE_TOKEN" | npx wrangler secret put HORIZON_SCRIBE_API_TOKEN --config cloudflare/wrangler.jsonc
```

If Wrangler asks to create the not-yet-existing Worker, confirm **only after checking the name and account**. Store the token in your password manager before closing the shell. To transfer it, display or copy the variable only while recording is stopped; the commands above deliberately do not print it.

Use a Worker **secret**, not a `vars` entry. Cloudflare documents this distinction in [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## 5. Build and deploy

```shell
npm run cloudflare:check
npm run cloudflare:deploy
```

The first command packages the example configuration without deploying. The second uses your local configuration and actually deploys. Record the HTTPS URL printed by Wrangler, usually shaped like `https://horizon-scribe.YOUR-SUBDOMAIN.workers.dev`.

Open `YOUR_WORKER_URL/health`. Expected response:

```json
{"ok":true,"service":"horizon-scribe"}
```

Health confirms that the Worker runs; it does **not** prove the bucket contains a valid dataset. Visiting `/v1/catalog` without authorization should return `401`. Before uploading your first dataset, an authenticated catalog request may return `503 CURRENT_UNAVAILABLE`—the current dataset pointer does not exist yet.

## 6. Upload a dataset, then its selected batch

Follow [Datasets](DATASETS.md) and [Desktop review](DESKTOP_REVIEW.md). For the login-based uploader:

```shell
node desktop/wrangler-upload.mjs --plan snapshots/DATASET_ID/upload-plan.jsonl --bucket horizon-scribe
node desktop/wrangler-upload.mjs --plan data/publish-round-01/next-pass-upload-plan.jsonl --bucket horizon-scribe
```

The first command uploads blobs and the snapshot, then switches `current.json`. The second publishes a queue for that exact dataset. No photos are sent to GitHub.

The Wrangler uploader verifies local file hashes and records progress locally. It does not perform remote checksum comparison or conditional create-only writes. The **S3 uploader** below provides those additional checks and is preferable for repeated/large uploads.

## 7. Optional: use bucket-scoped S3 credentials

In R2's API-token management screen, create credentials with **Object Read & Write** permission restricted to this bucket. Save the Access Key ID and Secret Access Key securely. These are **not** the same as the Worker app token. Follow Cloudflare's current [R2 authentication instructions](https://developers.cloudflare.com/r2/api/tokens/).

Configure these environment variables in the current desktop process or a protected secret manager:

```text
HORIZON_SCRIBE_R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
HORIZON_SCRIBE_R2_BUCKET=horizon-scribe
HORIZON_SCRIBE_R2_REGION=auto
HORIZON_SCRIBE_R2_PREFIX=production/horizon-scribe/v1
HORIZON_SCRIBE_R2_ACCESS_KEY_ID=<your bucket-scoped access key>
HORIZON_SCRIBE_R2_SECRET_ACCESS_KEY=<your bucket-scoped secret>
```

PowerShell uses `$env:NAME = 'value'`; macOS/Linux uses `export NAME='value'`. Supply real values privately, not in a recorded terminal. This repository does not automatically load `.env` files. The supplied uploader expects the standard account endpoint shown above, not a public bucket URL or jurisdiction-specific endpoint.

```shell
node desktop/upload-r2.mjs check
node desktop/upload-r2.mjs upload --plan snapshots/DATASET_ID/upload-plan.jsonl
node desktop/upload-r2.mjs upload --plan data/publish-round-01/next-pass-upload-plan.jsonl
```

Only an explicitly invoked upload publishes data. The app and Worker never need these S3 credentials.

## 8. Connect the iPad

Build using [the iPad instructions](../ios/README.md). Enter the **root HTTPS Worker URL**, without `/v1` or `/health`, and the app token from step 4. The app stores connection credentials in iPad Keychain.

The local desktop review server is not the iPad API. Do not enter `http://127.0.0.1:4317` on the iPad. The reviewer does not need to run while the iPad labels images.

## Custom domains, rotation, and maintenance

A custom domain is optional. Configure it on the **Worker**, not the R2 bucket, following [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Keep the app URL rooted at `/`. Reconnecting to a different URL creates a distinct local cache/draft namespace.

Rotate a token by generating a new value and repeating `wrangler secret put`, then reconnect every iPad. The old token stops authorizing requests. Do not clear an app with unsynced drafts merely to rotate its credentials.

To isolate users or environments, use separate Workers, buckets/prefixes, and tokens. There are no per-user roles. `ALLOWED_ORIGINS` is a browser policy, not a replacement for authentication.

Cloud review revisions are retained. Budget for storage growth and back up your bucket before any lifecycle/deletion policy. No cleanup or account teardown command is run by this repository automatically.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/health` fails | Deployment URL, Worker deployment, and network |
| `401 INVALID_HORIZON_SCRIBE_TOKEN` | Correct app token and secret name; no surrounding whitespace |
| `503 CURRENT_UNAVAILABLE` | Dataset upload completed; binding and prefix match the uploader |
| `INVALID_MANIFEST` | Manifest/pointer from the same snapshot; do not hand-edit uploaded immutable objects |
| `INVALID_NEXT_PASS` | Batch was built for this dataset; valid identities and at most 500 items |
| `409 DATASET_STALE` | Dataset changed; preserve draft, refresh catalog, do not force old labels into a new snapshot |
| `409 REVIEW_CONFLICT` | Another save changed the image; rebase/review in the app |
| `REVIEW_INDEX_BUSY` | Concurrent saves exhausted index retries; stop competing writers and retry/reconcile before exporting |
| R2 upload denied | Correct account/bucket; bucket-scoped credentials permit object reads and writes |
| Desktop reviewer unavailable | Keep terminal running; open exact `127.0.0.1` URL; choose a free `--port` if needed |

Cloudflare documentation was consulted during the October 24, 2026 port. Dashboard wording may change; use the official links above for the current interface.
