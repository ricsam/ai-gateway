# AI Gateway Helm chart

Deploys the OpenAI-compatible AI Gateway for AWS Bedrock, an optional single-node TimescaleDB, a migration Job, Service, and optional Ingress.

## Published repository

```bash
helm repo add ai-gateway https://ricsam.github.io/ai-gateway
helm repo update
helm search repo ai-gateway/ai-gateway
```

## Install

Create a Secret containing `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `SETTINGS_ENCRYPTION_KEY`, then run:

```bash
helm upgrade --install ai-gateway ai-gateway/ai-gateway \
  --namespace ai-gateway --create-namespace \
  --set image.repository=ghcr.io/your-org/ai-gateway \
  --set image.tag=0.1.0 \
  --set config.baseUrl=https://gateway.example.com \
  --set secrets.existingSecret=ai-gateway-secrets
```

See the Mintlify deployment guide in `docs/deployment/helm.mdx` for Ingress, bundled TimescaleDB, storage, and publication details.

## Release

Bump `version` in `Chart.yaml` whenever chart templates or default values change. Push to `main`; `.github/workflows/release-helm-chart.yml` packages the chart, creates a GitHub release, updates the `gh-pages` repository snapshot, and deploys it to GitHub Pages.
