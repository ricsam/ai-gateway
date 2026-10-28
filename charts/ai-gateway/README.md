# AI Gateway Helm chart

Deploys the OpenAI-compatible AI Gateway for AWS Bedrock, an optional single-node TimescaleDB, a migration Job, Service, and optional Ingress.

## Published repository

```bash
helm repo add ai-gateway https://ricsam.github.io/ai-gateway
helm repo update
helm search repo ai-gateway/ai-gateway
```

## Pre-built image

The chart pins the public multi-platform image containing this release's application changes:

```text
ghcr.io/ricsam/ai-gateway:sha-26d822e9879331a7ac51e593466a23a3323c9ac1
```

Every image publish creates an immutable `sha-<full-commit-sha>` tag. Git tags pushed directly to GitHub are published with the same name. Override `image.tag` only to select another build; chart `appVersion` identifies its default application build.

## Install

Create a Secret containing `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `SETTINGS_ENCRYPTION_KEY`, then run:

```bash
helm upgrade --install ai-gateway ai-gateway/ai-gateway \
  --namespace ai-gateway --create-namespace \
  --set config.baseUrl=https://gateway.example.com \
  --set secrets.existingSecret=ai-gateway-secrets
```

See the Mintlify deployment guide in `docs/deployment/helm.mdx` for Ingress, image pinning, bundled TimescaleDB, storage, and publication details.

## Upgrading to 0.1.11

This release adds no database migration; upgrading from 0.1.10 needs no special steps. Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below.

- `/v1/usage` adds a versioned, top-up-inclusive `budget` object and `observed_at`; the existing `credits` fields are unchanged.
- Analytics `timeRange` values, in the dashboards and the management API, are rolling windows ending now. The values are unchanged, but `month`, `quarter`, and `year` now mean exactly 30, 90, and 365 days instead of calendar months or years.
- Admin ledger usage summaries count only inference events. Administrator balance changes and monthly resets still change balances and stay in the ledger, but no longer count as consumption or requests.

## Upgrading to 0.1.10

Account enablement now controls both login and API access; the separate per-user API switch is removed. Existing valid keys work for enabled accounts even if their legacy API flag was disabled. Disabled accounts remain blocked, and key scopes, expiry, revocation, and credit limits still apply.

The pre-upgrade migration drops the obsolete `user.api_enabled` column. Back up the database and stop old application replicas before upgrading: old binaries require that column, so a rolling upgrade would leave them querying a removed column. Preserve your existing Helm values, secrets, and database/PVCs, and let the new chart restore the configured replica count. Do not reuse an old `image.tag` override. A Helm rollback does not undo database migrations; restoring an older application requires restoring a compatible database schema first.

## Release

Publish the application commit's image first and verify its AMD64 and ARM64 manifests. Bump `version` in `Chart.yaml`, set `appVersion` and the default `image.tag` to that published `sha-<full-commit-sha>`, and push to `main`. `.github/workflows/release-helm-chart.yml` packages the chart, creates a GitHub release, updates the `gh-pages` repository snapshot, and deploys it to GitHub Pages. `.github/workflows/publish-container-image.yml` builds the runtime image for AMD64 and ARM64 and publishes it to GHCR.
