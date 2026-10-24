# Contributing to HorizonScribe

Use a current Node 22.12+ or Node 24 installation. Install exactly the checked-in dependencies with `npm ci`.

```shell
npm run check
npm test
npm run cloudflare:check
```

Tests generate small synthetic scenes under temporary directories; no private photographs, cloud credentials, or production deployments are needed. `cloudflare:check` is a dry-run package build.

## Desktop browser tests

```shell
npx playwright install chromium
npm run test:browser
```

Linux CI uses `npx playwright install --with-deps chromium`. Browser tests start their own loopback review server and exercise real selection persistence, comparison toggles, queue ordering, and download behavior. Reports and screenshots are ignored.

## iPad verification on macOS

```shell
swift test --package-path ios/HorizonScribeCore
xcodebuild -project ios/HorizonScribe.xcodeproj -scheme HorizonScribe -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The CI simulator build does not need an Apple signing team. Installing on an iPad does. Changes to painting, gesture handling, cache/draft behavior, and synchronization also require the manual [device checklist](ios/README.md#device-acceptance-checklist).

## Dependency notes

Wrangler is pinned for consistent config/build/upload behavior. Its transitive `undici` version is overridden to 7.30.1 to address advisories found during the initial port. Recheck compatibility, `npm audit`, and Worker packaging whenever updating dependencies; do not blindly apply `npm audit fix --force` downgrades.

## Data and contribution boundaries

- Commit source and synthetic fixtures, never private photographs, masks, upload plans, credentials, generated bundles, or checkpoints.
- Do not add a default production hostname, account ID, signing team, Firebase configuration, or personal filesystem path.
- Keep any remote-write feature explicit. Opening the desktop reviewer must not deploy or upload.
- Preserve the mask mapping and dataset/revision checks across desktop, Worker, and Swift changes.
- Document schema changes and migration consequences. Existing drafts must not be silently reinterpreted.
- Include relevant tests and document what still needs real-device or live-account verification.

Contributions are provided under the project's MIT license. Avoid submitting third-party code/assets unless their license and provenance permit inclusion and required notices are preserved.
