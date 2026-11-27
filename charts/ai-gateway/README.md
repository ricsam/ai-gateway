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
ghcr.io/ricsam/ai-gateway:sha-5eac63c12341e0a0e9270dfd229e475ed5bd9e5c
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

## Manage the gateway with kubectl

The image includes `aigctl`, the management CLI. Run it in the gateway pod:

```bash
kubectl -n ai-gateway exec -it deploy/ai-gateway-ai-gateway -- aigctl --help
kubectl -n ai-gateway exec -it deploy/ai-gateway-ai-gateway -- aigctl setup init --username admin --email admin@example.com
```

Inside the container aigctl uses the pod's own database access, so anyone allowed to exec into the gateway's pods can administer it. See [Management CLI](https://github.com/ricsam/ai-gateway/blob/main/docs/administration/cli.mdx).

## Upgrading to 0.1.20

This release adds no database migration; upgrading from 0.1.19 needs no special steps. From 0.1.10 through 0.1.18, the pre-upgrade migration Job still applies the 0.1.19 migration (and from 0.1.10 or 0.1.11 the 0.1.12 migration, from 0.1.13 or earlier the 0.1.14 migration), and from 0.1.18 or earlier, register the new OpenID Connect callback before upgrading, as described under 0.1.19. Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below.

- New values `config.clientIpHeaders` and `config.trustedProxies` (`CLIENT_IP_HEADERS` and `TRUSTED_PROXIES` outside Helm) tell the gateway where a request's client address is behind proxies, so that sign-in rate limits count each client separately and sessions record the client's address. Name a header that a proxy sets to the client's address alone, such as `cf-connecting-ip` behind Cloudflare, or list the addresses or CIDR ranges of the proxies that append to `X-Forwarded-For`. Unset, the gateway behaves as in 0.1.19. It refuses to start when an entry isn't a header name, an IP address or a CIDR range. See [Client IP addresses](https://github.com/ricsam/ai-gateway/blob/main/docs/deployment/helm.mdx#client-ip-addresses).
- The pods now restart when the chart's ConfigMap changes, for example `config.baseUrl` or the new values. Before, a changed value took effect only at the pods' next restart.

## Upgrading to 0.1.19

This release adds migration `0008_credit_rollover`, which the pre-upgrade migration Job applies before the new application starts. It adds `monthly_credit_mode` (default `reset`), `rollover_cap`, `monthly_spend_limit` and `monthly_credits_applied_at` to `user`, with check constraints. Existing accounts keep the monthly reset with no rollover cap and no monthly spend limit; the migration is fast, needs no backfill and changes no existing data. Upgrading from 0.1.10 through 0.1.18 needs no other database steps (from 0.1.10 or 0.1.11, the pre-upgrade migration Job also applies the 0.1.12 migration, and from 0.1.13 or earlier the 0.1.14 migration, described below). Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below. The migration only adds columns, so an earlier application image still runs against the upgraded database.

- **Register the new OpenID Connect callback before upgrading.** Better Auth moves from 1.5.3 to 1.7.27 for its security advisories, and the provider callback moves from `<BASE_URL>/api/auth/oauth2/callback/<provider-key>` to `<BASE_URL>/api/auth/callback/<provider-key>`. Add the new redirect URI at each identity provider before deploying and remove the old one afterwards. Every ID token is now verified, so a provider whose discovery publishes no `jwks_uri` is left unavailable, and a configured subject claim that is missing rejects the sign-in instead of falling back to `sub`. See [Redirect URI](https://github.com/ricsam/ai-gateway/blob/main/docs/administration/authentication.mdx#redirect-uri).
- Better Auth 1.7 tells clients apart for its rate limits, such as 3 sign-in attempts per 10 seconds, only by an `X-Forwarded-For` header that holds a single address. Requests without one, or with a list of addresses, share one limit per path, and the log says `Rate limiting could not determine a client IP` once. 1.5.3 didn't limit requests without the header and used the first address of a list.
- The image runs Bun 1.4.5, a security release that updates BoringSSL, c-ares, llhttp and HTTP/3; 1.4.4 fixed the brotli decoder's CVE-2026-111497. The base image is pinned by digest.
- **Monthly credit control.** Each account has a monthly credit mode: `reset` (the default, as before) or `rollover`, which adds the monthly credits to the balance, up to an optional rollover cap. An optional maximum monthly spend, in either mode, caps the metered usage charged in a UTC calendar month; past it, inference returns `402 monthly_spend_limit_reached` until the next month. Set them in **Admin → Users** and **Admin → Groups**, with `--monthly-credit-mode`, `--rollover-cap` and `--monthly-spend-limit` on `aigctl users create`/`update` and `aigctl groups bulk-update`, or with the management API's `monthlyCreditMode`, `rolloverCap` and `monthlySpendLimit`. A rollover account receives one month's credits once per UTC month, so applying monthly credits by hand again skips it, while reset accounts are reset every time, as before. `/v1/credits` and the `/v1/usage` `credits` object add `monthly_credit_mode`, `rollover_cap`, `monthly_spend_limit` and `monthly_spend_remaining`. See [Monthly credits](https://github.com/ricsam/ai-gateway/blob/main/docs/credits.mdx#monthly-credits).
- **Analytics.** Every analytics page offers **Custom range** (From and To, to the minute), and **Admin → Analytics** has a **People** filter for any users and groups. The management API's analytics endpoints take `start` and `end` (ISO 8601 dates, or dates and times with `Z` or a UTC offset) as an alternative to `timeRange`, and repeated `userId` and `groupId`, up to 100 in all; sending both now selects their union instead of returning `400`. `aigctl analytics` takes `--from`/`--to` and repeated `--user`/`--group`. Throughput's `activeHours` can now be fractional, and the charts use the Okabe-Ito palette instead of shades of blue. See [Analytics time ranges](https://github.com/ricsam/ai-gateway/blob/main/docs/administration/management-api.mdx#analytics-time-ranges).
- **Upstream failures.** A refused, reset or timed-out connection to Bedrock, a DNS or HTTP/2 failure, or a 502/503/504 from a proxy in front of it now returns `503 service_unavailable` instead of `500` with the SDK's message, on Chat Completions and the native Bedrock endpoints, so clients retry it. A streamed Chat Completion whose upstream breaks off before the end now ends with an error event (`code: stream_interrupted`) instead of `data: [DONE]`, after charging the usage that arrived. Other gateway-side failures return `500 internal_error` with `Internal server error` and log the details. New log lines: `Upstream unavailable:`, `Stream failed:` and `Stream completed with no usage metadata:`. See [When the upstream breaks off a stream](https://github.com/ricsam/ai-gateway/blob/main/docs/chat-completions.mdx#when-the-upstream-breaks-off-a-stream).
- **Web UI.** Pages no longer answer `500` when the request's `Host` header doesn't lead back to the server, for example behind `kubectl port-forward` on a local port other than 3000. The server reads its HTML from its own listener instead of the `Host` header's address, so it no longer sends a client's cookies or `Authorization` header there, and page routes answer methods other than `GET` and `HEAD` with `405`.

## Upgrading to 0.1.18

This release adds no database migration; upgrading from 0.1.10 through 0.1.17 needs no special steps (from 0.1.10 or 0.1.11, the pre-upgrade migration Job still applies the 0.1.12 migration, and from 0.1.13 or earlier the 0.1.14 migration, described below). Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below.

- `GET /v1/models` now also lists each model's `context_window` (`null` when none is configured) and `max_output_tokens`, the most output tokens a request may ask for. An alias and its app tiers list their upstream model's. The existing fields are unchanged. See [Listing models](https://github.com/ricsam/ai-gateway/blob/main/docs/chat-completions.mdx#listing-models).
- Nothing needs changing on upgrade. Clients that read these fields size their requests by them, so check the values in **Admin → Models** or with `aigctl models list -o wide`, and set them with `aigctl models update <model> --context-window <tokens> --max-output-tokens <tokens>`.

## Upgrading to 0.1.17

This release adds no database migration; upgrading from 0.1.10 through 0.1.16 needs no special steps (from 0.1.10 or 0.1.11, the pre-upgrade migration Job still applies the 0.1.12 migration, and from 0.1.13 or earlier the 0.1.14 migration, described below). Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below.

- `GET /v1/models` now also lists each model's, alias's and app tier's display `name`, the `efforts` a request may send as `reasoning_effort`, its `default_effort` (`null` when none is configured), and, for pinned aliases and their app tiers, the `effort` they always run at. The existing fields are unchanged. See [Listing models](https://github.com/ricsam/ai-gateway/blob/main/docs/chat-completions.mdx#listing-models).
- Nothing needs changing on upgrade. To show readable names in clients, name your aliases (`aigctl aliases update <alias> --name 'Claude Opus 5.5'`): an alias created with aigctl without `--name` is named after its ID.

## Upgrading to 0.1.16

This release adds no database migration; upgrading from 0.1.10 through 0.1.15 needs no special steps (from 0.1.10 or 0.1.11, the pre-upgrade migration Job still applies the 0.1.12 migration, and from 0.1.13 or earlier the 0.1.14 migration, described below). Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below.

- Models, model aliases and apps can be managed through the management API (`/management/v1/models`, `/model-aliases` and `/model-apps`; scopes `models.read` and `models.write`) and with `aigctl models`, `aigctl aliases` and `aigctl apps`, not only in the admin UI. See [Models, aliases and apps](https://github.com/ricsam/ai-gateway/blob/main/docs/administration/management-api.mdx#models-aliases-and-apps).
- `GET /management/v1/models` entries now include `available`: whether `/v1/models` lists the model. The other fields are unchanged.
- In **Admin → Models**, emptying a cache price, the context window, the description or the region and saving now clears it; before, the earlier value was kept. Model saves now refuse prices above 999,999,999,999 and non-integer token limits with a validation error instead of failing with a server error.
- Model, alias and app audit events now record the entry's public ID or app name, and alias and app updates record the changed fields.
- The image no longer includes `.env` files from the build directory. Published images were built without them; this protects local `docker build` and `docker compose build` runs.

## Upgrading to 0.1.15

This release adds no database migration; upgrading from 0.1.10 through 0.1.14 needs no special steps (from 0.1.10 or 0.1.11, the pre-upgrade migration Job still applies the 0.1.12 migration, and from 0.1.13 or earlier the 0.1.14 migration, described below). Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below.

- The image includes `aigctl`, a management CLI for users, groups, inference and management keys, credits, settings, branding, AWS credentials, login providers, audit history, usage and analytics: `kubectl exec -it deploy/<release>-ai-gateway -- aigctl users list`. Inside the container it works on the gateway's database directly, so it needs no management key; its changes are audited as `cli aigctl@<pod>`. Treat `pods/exec` on the namespace as administrative access to the gateway. With `--server` and a management key, it also works against the management API from elsewhere.
- `aigctl setup init` completes first-boot setup from inside the cluster, so a new installation never has to expose an open `/setup` page. `helm install` now prints the command.
- `GET /management/v1/users?search=` matches the username and display name as well as the email, and treats `%` and `_` literally.
- The management API answers `409 conflict` instead of `500` when a name is already taken (for example a duplicate group name), and its error log no longer includes query parameters.

## Upgrading to 0.1.14

This release adds migration `0007_reasoning_replay`, which the pre-upgrade migration Job applies before the new application starts. It creates the empty `reasoning_replay_entries` table and adds `application_settings.reasoning_replay_enabled` (default `true`): it is fast, needs no backfill and changes no existing data. Upgrading from 0.1.10 through 0.1.13 needs no special steps (from 0.1.10 or 0.1.11, the pre-upgrade migration Job also applies the 0.1.12 migration described below). Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below. The migration only adds a table and a column, so an earlier application image still runs against the upgraded database.

- Chat Completions now send Claude's earlier reasoning back to Bedrock. OpenAI-format clients never receive thinking signatures, so the gateway stores the reasoning blocks of each Claude response with thinking on and puts them back, unmodified and in place, into the matching assistant turns of later requests, as long as the conversation before them is unchanged. In tool loops Claude continues from its earlier reasoning instead of working the problem out again at every step. Replayed reasoning counts as input tokens, mostly cache reads. See [Reasoning across turns](https://github.com/ricsam/ai-gateway/blob/main/docs/chat-completions.mdx#reasoning-across-turns).
- Stored reasoning belongs to one user and upstream model, is kept for 7 days after its last use and is deleted with its user. A long max-effort step can store up to about a megabyte, so the table grows with thinking-heavy usage. **Admin → Brand & AWS → Inference → Send Claude's earlier reasoning back** (or `reasoningReplayEnabled` at `/management/v1/settings`) turns replay off and deletes what is stored.
- Replay never fails a request: on Claude Opus, Sonnet and Haiku 5.5 and later the gateway sends `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` with the `thinking-binding-controls-2026-08-01` beta, and a request Bedrock rejects is sent once more without replayed reasoning.
- New log lines: `[OpenAI Proxy] Reasoning replay: request=…` for each request with thinking (replayed, missing and stale turns), `Reasoning stored:`, `Reasoning replay rejected, retrying without it` and `Bedrock dropped replayed reasoning`.

## Upgrading to 0.1.13

This release adds no database migration; upgrading from 0.1.10, 0.1.11 or 0.1.12 needs no special steps (from 0.1.10 or 0.1.11, the pre-upgrade migration Job still applies the 0.1.12 migration described below). Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below.

- Streamed Chat Completions now log why Bedrock ended each response, as non-streamed ones already did. A warning `[OpenAI Proxy] Stop reason: request=… model=… stream=… stop=…` is logged when a response ends for a reason other than finishing its turn, calling a tool or reaching a stop sequence, such as a content filter, guardrail, output limit or malformed output, and every `Complete:` line includes `stop=<reason>`.
- `Complete:` and `Stream canceled:` lines also include `request=<id>`, the request ID of the request's first log line (the client's `X-Request-ID` when it supplies a valid one), so a stopped or cancelled response can be traced to its client request. The non-streaming warning no longer fires for `tool_use` or `stop_sequence`, and its old `Non-streaming stop reason:` wording is replaced by the line above; update log searches or alerts that match the old text.

## Upgrading to 0.1.12

This release adds migration `0006_realtime_credit_aggregates`, which the pre-upgrade migration Job applies before the new application starts. It only switches the `credit_events_5m`, `credit_events_1h`, and `credit_events_1d` continuous aggregates to real-time aggregation (`timescaledb.materialized_only = false`): it is fast, keeps all data, needs no backfill, and leaves the refresh policies unchanged. Upgrading from 0.1.10 or 0.1.11 needs no special steps. Upgrading from 0.1.9 or earlier still applies the 0.1.10 migration, so follow the 0.1.10 procedure below.

- Analytics charts include usage up to the time of the request, including the current day and hour, and count the in-window part of the window's first bucket. Earlier releases left out usage that the refresh policies had not yet materialized, such as the whole current day in day-bucketed charts, and usually showed the first bucket, such as the first day of **Last 7 days**, as empty. Charts with intervals of 5 minutes or longer now also aggregate ledger rows newer than each aggregate's last refresh, so they can take slightly longer.
- A new **Throughput** card on **Admin → Analytics**, the admin user and group pages, and **Profile** shows steady-state and peak tokens and requests per minute and the average input and output tokens per request, overall and per upstream model: the values a Bedrock quota increase request asks for. The management API serves them at `GET /management/v1/analytics/throughput` with the `usage.read` scope. They are computed from the raw ledger without a new migration; on large ledgers, system-wide values over long ranges can take several seconds.

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
