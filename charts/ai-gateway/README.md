# AI Gateway Helm chart

Deploys the OpenAI-compatible AI Gateway for AWS Bedrock, an optional single-node TimescaleDB, a migration Job, Service, and optional Ingress.

## Published repository

```bash
helm repo add ai-gateway https://ricsam.github.io/ai-gateway
helm repo update
helm search repo ai-gateway/ai-gateway
```

## Pre-built image

The chart uses the public multi-platform image published from this repository by default:

```text
ghcr.io/ricsam/ai-gateway:latest
```

Every image publish also creates an immutable `sha-<full-commit-sha>` tag. Git tags pushed directly to GitHub are published with the same name. Pin one of those tags through `image.tag` for reproducible production deployments.

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

Bump `version` in `Chart.yaml` whenever chart templates or default values change. Push to `main`; `.github/workflows/release-helm-chart.yml` packages the chart, creates a GitHub release, updates the `gh-pages` repository snapshot, and deploys it to GitHub Pages. `.github/workflows/publish-container-image.yml` builds the runtime image for AMD64 and ARM64 and publishes it to GHCR.
