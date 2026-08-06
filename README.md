# AI Gateway

A self-hosted AI gateway for AWS Bedrock with an OpenAI-compatible inference API and database-backed administrative control plane. Administrators manage local users, groups, models/pricing, branding, login integrations, AWS credentials, credits, management keys, and audit history at runtime.

## First boot

The application needs only four deployment values:

```dotenv
BASE_URL=https://gateway.example.com
DATABASE_URL=postgres://...
BETTER_AUTH_SECRET=<strong random secret>
SETTINGS_ENCRYPTION_KEY=v1:<base64 of exactly 32 random bytes>
```

Run migrations, start the service, and visit `/setup`. The first successful visitor creates the initial local administrator and permanently closes setup. **Do not expose an unconfigured installation's Ingress until an operator can immediately complete setup.** A safe rollout creates the database and private service first, completes setup through a protected tunnel/port-forward, then enables public Ingress.

The encryption key protects OIDC, trusted-header, and AWS secret material. Back it up with the database; losing it makes encrypted settings unrecoverable. Do not rotate it by replacing the environment value alone—decrypt/re-encrypt all envelopes in a maintenance operation first.

## Management API

The stable management base is `/management/v1`; its OpenAPI document is `/management/v1/openapi.json`. Browser calls use an enabled administrator session and same-origin mutation checks. Automation uses one-time-displayed `aigm_` management keys with granular scopes. Management keys cannot invoke `/v1` inference.

```sh
curl https://gateway.example.com/management/v1/users \
  -H 'Authorization: Bearer aigm_...'
```

Core resources include users and passwords, groups/memberships and bulk user controls, auth providers, branding/assets, AWS settings/tests, usage reporting, management keys, and audit events. Configuration updates use revisions. Secret writes use `{ "operation": "preserve" }`, `{ "operation": "replace", "value": "..." }`, or `{ "operation": "clear" }`; plaintext secrets are never returned.

## Inference API

| Method | Endpoint | Inference-key scope |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | `ai.invoke` |
| `GET` | `/v1/models` | `models.read` |
| `GET` | `/v1/credits` | `credits.read` |
| `POST` | `/api/gateway/bedrock/invoke` | `ai.invoke` |
| `POST` | `/api/gateway/bedrock/invoke-stream` | `ai.invoke` |
| `POST` | `/api/gateway/bedrock/converse` | `ai.invoke` |
| `POST` | `/api/gateway/bedrock/converse-stream` | `ai.invoke` |

The four native compatibility endpoints retain Bedrock request/response shapes, managed prompt caching, raw NDJSON/binary streaming, cancellation, and metered settlement. Send a stable `X-Request-ID` when a client may retry a completed request; settlement receipts make the same request ID exactly-once. The OpenAI endpoint accepts the same header.

Inference keys begin with `aig_`, are shown once, and are stored as SHA-256 digests. The app remains healthy and ready before AWS is configured; inference then returns `provider_not_configured`. Configure encrypted static AWS credentials and a default region in Admin → Brand & AWS. Per-model region overrides remain supported.

## Authentication and groups

Local username/password login is always the recovery path. Public registration is disabled after the atomic first-boot transaction. Administrators create local users, choose initial passwords, and may force password change on first login. Disabling a user invalidates sessions. Final enabled-administrator safeguards cover demotion, disablement, and deletion.

Groups organize membership and reporting; credits remain user-owned. The Groups screen can select multiple groups and apply monthly quota, API-access, or account-enablement changes to the union of their members. External identities are anchored by provider and immutable subject. Implicit email-based account linking is disabled.

The Authentication screen and management API configure generic OIDC and trusted-header providers, encrypted secrets, discovery tests, claim/header mapping, provisioning policy, and no-restart revisions. Trusted-header authentication is an explicit advanced mode: the immediate TCP peer must match a configured CIDR, the proxy must strip client-supplied identity headers, and every request must carry the configured shared secret. Forwarded client-IP headers are never used as the trusted source address.

## Operations

### Local development / Compose

```sh
cp .env.example .env
# Generate strong BETTER_AUTH_SECRET and SETTINGS_ENCRYPTION_KEY values.
docker compose up --build -d
```

Compose runs the pinned `timescale/timescaledb:2.19.3-pg17` distribution, a one-shot migration, and the app. No OIDC, AWS, bootstrap-admin, or branding values belong in Compose. Set `POSTGRES_PORT` only when host access to PostgreSQL is needed; application traffic uses the internal service.

### Helm

The chart is published as a public HTTPS Helm repository and uses the public `ghcr.io/ricsam/ai-gateway:latest` multi-platform image by default:

```sh
helm repo add ai-gateway https://ricsam.github.io/ai-gateway
helm repo update
helm upgrade --install ai-gateway ai-gateway/ai-gateway \
  --namespace ai-gateway --create-namespace \
  --set config.baseUrl=https://gateway.example.com \
  --set secrets.existingSecret=ai-gateway-secrets \
  --set ingress.enabled=true \
  --set ingress.host=gateway.example.com
```

For reproducible production deployments, set `image.tag=sha-<full-commit-sha>` rather than following `latest`. The existing secret contains `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `SETTINGS_ENCRYPTION_KEY`. The bundled database uses the pinned TimescaleDB/PostgreSQL 17 image and defaults to `ReadWriteOnce` with `rook-ceph-block`; use external TimescaleDB for HA. Plain PostgreSQL is not supported: the migration intentionally fails if the `timescaledb` extension cannot be created. External operators should provision a TimescaleDB release compatible with PostgreSQL 17 and permit the migration role to create the extension. ServiceAccount annotations remain generic infrastructure and do not imply workload-identity support. See the [Helm deployment guide](docs/deployment/helm.mdx) for repository publication and complete installation options.

### Backups and recovery

Back up TimescaleDB and `SETTINGS_ENCRYPTION_KEY` together. Restore them as a pair and retain `BETTER_AUTH_SECRET` if existing sessions should remain valid. Use Timescale-aware logical backups (`pg_dump`/`pg_restore` with the extension installed at the same compatible version) or a storage/database snapshot that includes extension catalogs. Restore into an empty database, install TimescaleDB first, restore, then run migrations and verify `timescaledb_information.hypertables`, all three `credit_events_*` continuous aggregates, refresh jobs, and the compression policy. Test restores regularly; do not reset by dropping extension-owned views individually.

With database access, recover a local administrator offline:

```sh
DATABASE_URL=postgres://... bun run admin:recover -- username 'new-strong-password'
```

This promotes/enables the user, replaces or creates its credential account, revokes sessions, and requires another password change after login. It does not reopen first-boot setup.

Rotate AWS keys by saving replacement credentials in Admin → Brand & AWS, testing a configured model, then revoking the former key in AWS. Clearing credentials makes enabled models unavailable. Secret values and sensitive test errors are excluded from API responses and audit metadata.

## Development checks

```sh
bun install --frozen-lockfile
bun run routes:generate
bun run typecheck
bun test
bun run db:migrate
TIMESCALE_ADMIN_URL=postgres://... bun run timescale:verify

docker compose config
helm lint charts/ai-gateway
helm template ai-gateway charts/ai-gateway --set secrets.values.authSecret=test --set secrets.values.settingsEncryptionKey=v1:test --set secrets.values.databaseUrl=postgres://example
```

This is a greenfield pre-release baseline. The product intentionally excludes RAG/documents/embeddings and persistent full-chat features. Current group analytics use current-membership attribution, so a user in multiple groups contributes to every applicable group summary.
