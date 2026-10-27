# Security

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/tabutyn/horizon-scribe/security/advisories/new) when enabled. If unavailable, contact the maintainer privately before disclosing sensitive details. Do not include API tokens, R2 credentials, photos, masks, or private Worker URLs in a public issue.

## Credential boundaries

- `HORIZON_SCRIBE_API_TOKEN`: shared app token stored as a Cloudflare Worker secret and in iPad Keychain. It grants every API capability implemented by that Worker.
- R2 binding: capability attached by Cloudflare directly to Worker. No credential value exists in source.
- `HORIZON_SCRIBE_R2_ACCESS_KEY_ID` and `HORIZON_SCRIBE_R2_SECRET_ACCESS_KEY`: optional desktop-only upload credentials. Restrict them to one bucket and never place them in app, source, JSON manifests, or Worker variables.
- Wrangler login: optional desktop upload/deployment session managed by Wrangler.
- Mac iPad installer: token is read from Keychain or supplied via stdin/environment, never a CLI argument. Only non-secret settings are saved in ignored `.local/ios-device.json`. A mode-0600 transfer file in a mode-0700 temporary directory is copied through the paired-device connection into the app's private `Library/Caches`. The Mac copy is removed after transfer; the app protects the received file, saves credentials in device-only Keychain, then removes it before connecting. If import fails, unlock the device and retry to consume the pending file. Credentials are never compiled into an app bundle; distributing the build alone does not distribute access to your Worker.

Keep R2 bucket private. Rotate app token after device loss or team-member removal. Use separate deployments for separate trust groups.

## Known scope

Current authentication is one shared bearer token, suitable for an individual or small trusted team. It does not provide per-user attribution, revocation, roles, audit identities, rate limiting, or multi-tenant isolation. Review records identify writer as `self-hosted`. Add an identity layer before using HorizonScribe with untrusted users.

The desktop reviewer binds only to `127.0.0.1`, rejects foreign Host/Origin values, and serves fixed UI/preview routes rather than arbitrary filesystem paths. Local users and the bundle files are trusted; it is not an internet-facing service. Do not expose it through port forwarding or a tunnel.

The model/prediction import process reads only files explicitly supplied by the user. Treat source manifests and upload plans as trusted local inputs: they can reference local files and upload plans contain absolute paths. Inspect them before running another person's plan with your cloud credentials.

Normal cloud saves retain earlier revisions. There is no public cleanup endpoint. Dataset and review-pointer updates use separate R2 objects, not a cross-object transaction; use a single publisher for dataset/queue changes and verify exports after concurrent editing or interrupted requests.
