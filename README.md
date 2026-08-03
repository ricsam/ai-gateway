# White-Label LLM Proxy

A self-hosted, runtime-brandable proxy for AWS Bedrock. It exposes an OpenAI-compatible API, OIDC user login, user-owned credits, scoped API keys, usage attribution, model administration, teams, and a deliberately small stateless model playground.

This project is the proxy and billing/authorization boundary. It is not a full chat or document-writing product.

## API

The stable client base URL is `https://your-proxy.example/v1`.

| Method | Endpoint | Required API-key scope |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | `llm.invoke` |
| `GET` | `/v1/models` | `models.read` |
| `GET` | `/v1/credits` | `credits.read` |

API keys begin with `llmp_`, are shown once, and are stored only as SHA-256 digests. Keys can be scoped, expired, and revoked. Both streaming SSE and non-streaming chat completions are supported, including the implemented OpenAI tools subset.

```sh
curl https://proxy.example.com/v1/chat/completions \
  -H 'Authorization: Bearer llmp_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "configured-bedrock-model-id",
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

OpenAI-compatible clients such as OpenCode or Pi can use:

```sh
OPENAI_BASE_URL=https://proxy.example.com/v1
OPENAI_API_KEY=llmp_...
```

## Breaking fresh-database release

This version intentionally does not migrate the former product database. Use a new database or a new persistent volume. Do not run the reset command against data you need.

For an explicit local reset:

```sh
ALLOW_DATABASE_RESET=true DATABASE_URL=postgres://... bun run db:reset
bun run db:migrate
```

Startup never drops data and does not run migrations implicitly.

## OIDC login

Register one confidential OpenID Connect client at the customer identity provider. The callback URI is:

```text
${BASE_URL}/api/auth/oauth2/callback/${OIDC_PROVIDER_ID}
```

The default provider ID is `oidc`. Discovery defaults to `${OIDC_ISSUER}/.well-known/openid-configuration`. Authorization code flow, optional PKCE, issuer validation, and the standard `openid profile email` scopes are configured through environment variables.

Users are provisioned on first successful OIDC login. Role, enabled state, API access, and credits are server-owned fields and are never accepted from arbitrary IdP claims.

### Bootstrap administrators

At deployment, provide comma-separated immutable OIDC subjects:

```sh
BOOTSTRAP_ADMIN_SUBJECTS=00u123,00u456
```

Verified normalized emails are supported as a convenience fallback:

```sh
BOOTSTRAP_ADMIN_EMAILS=admin@example.com
```

A match promotes the user after login and configuration changes never implicitly demote anyone. Existing administrators can promote or demote users in the admin UI. The backend rejects attempts to disable or demote the final enabled administrator.

## Runtime branding

Branding is read at runtime, so one image can serve many installations:

- `BRAND_NAME`
- `BRAND_TAGLINE`
- `BRAND_LOGO_URL`
- `BRAND_FAVICON_URL`
- `BRAND_PRIMARY_COLOR` (six-digit hex)
- `BRAND_PRIMARY_FOREGROUND_COLOR` (six-digit hex)
- `BASE_URL`

See [`.env.example`](.env.example) for the complete environment contract.

## Local development

Prerequisites: Bun 1.3.14+, Docker, and an OIDC client.

```sh
cp .env.example .env
# Fill in OIDC, AWS, and secret values.
docker compose up -d postgres
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

Open `http://localhost:3000`. AWS credentials need `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions for configured model IDs/regions.

Useful commands:

```sh
bun run typecheck
bun test
bun run routes:generate
bun run db:generate
bun run db:migrate
docker compose config
helm lint charts/llm-proxy
```

## Docker Compose deployment

Compose provides:

- `postgres`: PostgreSQL 17 with a named volume
- `migrate`: one-shot Drizzle migration
- `app`: the proxy and UI, started after migration succeeds

```sh
cp .env.example .env
# Set production values and a strong random BETTER_AUTH_SECRET.
docker compose up --build -d
```

Back up the `postgres_data` volume/database before upgrades. For this breaking release, choose a new volume instead of attaching an old product database.

## Helm deployment

The chart is at [`charts/llm-proxy`](charts/llm-proxy). External PostgreSQL and an existing Kubernetes Secret are recommended for production.

```sh
helm upgrade --install proxy charts/llm-proxy \
  --namespace llm-proxy --create-namespace \
  --set image.repository=ghcr.io/your-org/llm-proxy \
  --set image.tag=0.1.0 \
  --set config.baseUrl=https://proxy.example.com \
  --set config.oidc.issuer=https://id.example.com \
  --set secrets.existingSecret=llm-proxy-secrets \
  --set ingress.enabled=true \
  --set ingress.host=proxy.example.com
```

The existing Secret must contain keys configured under `secrets.keys` (defaults: `DATABASE_URL`, `BETTER_AUTH_SECRET`, OIDC client ID/secret, and AWS credentials). With bundled PostgreSQL, the chart normally creates that Secret and also stores `POSTGRES_PASSWORD`; if you set `secrets.existingSecret`, include `POSTGRES_PASSWORD` in it as well. Set `postgresql.externalSecret=true` only when another secret controller creates the named Secret. The chart also has an optional single-node PostgreSQL StatefulSet for small installations:

```sh
--set postgresql.enabled=true \
--set postgresql.persistence.storageClass=rook-ceph-block
```

It uses `ReadWriteOnce`, mounts the complete volume without `subPath`, and defaults to `rook-ceph-block`. Use a managed external database for high availability and operational backups. The chart includes probes, security contexts, configurable resources, an optional migration Job, Service, and Ingress. No TLS block is emitted; use the ingress controller or edge termination appropriate for the cluster.

## Authentication extension contract

Inference and billing receive a normalized principal:

```ts
interface ProxyPrincipal {
  userId: string;
  credentialType: "api_key" | "session";
  credentialId: string;
  scopes: ReadonlySet<string>;
}
```

API keys implement the public API verifier today; sessions adapt to the same principal for the playground. Future integrations should add a verifier that produces this principal rather than changing model or billing code.

A later independent chat application can register one deployment client, authenticate its user with customer OIDC, and exchange that signed identity at an RFC 8693 token endpoint. Planned, not currently implemented:

- `POST /oauth/token` token exchange
- proxy-issued short-lived JWT access tokens
- `/.well-known/oauth-authorization-server` and `/.well-known/jwks.json`
- optional direct external-OIDC API tokens
- explicitly enabled trusted identity assertions

The intended pairing model is one manually provisioned client ID/secret per chat installation. The deployment credential authenticates the installation; the signed OIDC token authenticates the human. A future verifier should validate the deployment's allowed issuer, audience, signature, expiry, and requested scopes, map `(deployment, issuer, subject)` to a proxy user/team, and then emit the same `ProxyPrincipal` consumed today. The short-lived proxy token should carry user, team, deployment/client, audience, scope, and expiry claims.

Direct external-OIDC bearer acceptance is an advanced alternative when the customer can issue an access token specifically for this proxy audience. Trusted-identity assertions are a separate weaker mode for upstream trusted-header deployments: they trust the chat backend to authenticate users, must use authenticated deployment credentials, and must remain disabled by default. The proxy and chat installations never need to share a database, Kubernetes namespace, session secret, or OIDC implementation.

## Data and billing

Credits are owned by users. Teams organize membership and reporting but do not fund requests. Every billed request records user, API-key credential (when applicable), source (`api` or `playground`), model, token/cache usage, component costs, and credits charged in an append-only PostgreSQL ledger. Settlements lock the user row so concurrent completions cannot charge beyond the available balance.
