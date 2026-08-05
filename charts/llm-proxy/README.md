# LLM Proxy Helm chart

Deploys the OpenAI-compatible AWS Bedrock proxy, an optional single-node TimescaleDB, a migration Job, Service, and optional Ingress.

## Published repository

```bash
helm repo add ai-gateway https://ricsam.github.io/ai-gateway
helm repo update
helm search repo ai-gateway/llm-proxy
```

## Install

Create a Secret containing `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `SETTINGS_ENCRYPTION_KEY`, then run:

```bash
helm upgrade --install proxy ai-gateway/llm-proxy \
  --namespace llm-proxy --create-namespace \
  --set image.repository=ghcr.io/your-org/llm-proxy \
  --set image.tag=0.1.0 \
  --set config.baseUrl=https://proxy.example.com \
  --set secrets.existingSecret=llm-proxy-secrets
```

See the Mintlify deployment guide in `docs/deployment/helm.mdx` for Ingress, bundled TimescaleDB, storage, and publication details.

## Release

Bump `version` in `Chart.yaml` whenever chart templates or default values change. Push to `main`; `.github/workflows/release-helm-chart.yml` packages the chart, creates a GitHub release, and updates the `gh-pages` repository index.
