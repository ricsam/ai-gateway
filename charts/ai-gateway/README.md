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
ghcr.io/ricsam/ai-gateway:sha-2acd41e40129e8d6be2936b35ebf84d6bd83db46
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

## Release

Publish the application commit's image first and verify its AMD64 and ARM64 manifests. Bump `version` in `Chart.yaml`, set `appVersion` and the default `image.tag` to that published `sha-<full-commit-sha>`, and push to `main`. `.github/workflows/release-helm-chart.yml` packages the chart, creates a GitHub release, updates the `gh-pages` repository snapshot, and deploys it to GitHub Pages. `.github/workflows/publish-container-image.yml` builds the runtime image for AMD64 and ARM64 and publishes it to GHCR.
