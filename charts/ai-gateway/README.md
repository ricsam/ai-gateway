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
ghcr.io/ricsam/ai-gateway:sha-46d763e1a2508d9311342efec54fe52f26f5e5db
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
