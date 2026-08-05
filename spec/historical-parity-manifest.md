# Historical parity manifest

Baseline: pre-force-push commit `2140c21`. This manifest classifies every historical application, shared, migration, infrastructure, script, patch, and root runtime/tooling path in the plan inventory. `adapt` includes moves and consolidation; detailed subsystem semantics follow the table.

| Historical path | Class | Disposition |
| --- | --- | --- |
| `Dockerfile` | adapt | retained/adapted |
| `README.md` | adapt | retained/adapted |
| `backend/admin-guard.ts` | adapt | retained/adapted |
| `backend/analytics-service.ts` | adapt | replaced or consolidated in current white-label implementation |
| `backend/anocca-client.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/api-key-auth.ts` | adapt | retained/adapted |
| `backend/auth.ts` | adapt | retained/adapted |
| `backend/bedrock-proxy.ts` | adapt | replaced or consolidated in current white-label implementation |
| `backend/bedrock.ts` | adapt | retained/adapted |
| `backend/chat-resume.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/chat-store.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/chat-stream.ts` | adapt | replaced or consolidated in current white-label implementation |
| `backend/credentials-plugin.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/credit-service.ts` | adapt | retained/adapted |
| `backend/credit-settlement.test.ts` | keep | unchanged |
| `backend/credit-settlement.ts` | keep | unchanged |
| `backend/db.ts` | keep | unchanged |
| `backend/docling.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/document-processor.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/embedding.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/env.ts` | adapt | retained/adapted |
| `backend/head-tags.ts` | adapt | retained/adapted |
| `backend/jobs/reset-credits.ts` | adapt | retained/adapted |
| `backend/knowledge-base-upload.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/monthly-credit-reset-scheduler.ts` | adapt | retained/adapted |
| `backend/openai-proxy/handler.ts` | adapt | retained/adapted |
| `backend/openai-proxy/transform/cache-converse.ts` | keep | unchanged |
| `backend/openai-proxy/transform/cache-invoke.ts` | keep | unchanged |
| `backend/openai-proxy/transform/cache-usage.ts` | keep | unchanged |
| `backend/openai-proxy/transform/request.ts` | keep | unchanged |
| `backend/openai-proxy/transform/response.ts` | keep | unchanged |
| `backend/openai-proxy/transform/stream.ts` | keep | unchanged |
| `backend/openai-proxy/transform/types.ts` | adapt | retained/adapted |
| `backend/openai-proxy/transform/utils.ts` | keep | unchanged |
| `backend/router.ts` | adapt | retained/adapted |
| `backend/runtime-globals.d.ts` | adapt | retained/adapted |
| `backend/schema.ts` | adapt | retained/adapted |
| `backend/server.ts` | adapt | retained/adapted |
| `backend/storage.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/stream-store.ts` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `backend/stream-utils.ts` | keep | unchanged |
| `backend/tsconfig.json` | adapt | retained/adapted |
| `bunfig.toml` | keep | unchanged |
| `components.json` | keep | unchanged |
| `docker-compose.yml` | adapt | retained/adapted |
| `drizzle/0000_extensions.sql` | adapt | replaced or consolidated in current white-label implementation |
| `drizzle/0001_baseline.sql` | adapt | replaced or consolidated in current white-label implementation |
| `drizzle/0002_credit_events_hypertable.sql` | adapt | replaced or consolidated in current white-label implementation |
| `drizzle/0003_seed_data.sql` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `drizzle/meta/0000_snapshot.json` | adapt | retained/adapted |
| `drizzle/meta/0001_snapshot.json` | adapt | replaced or consolidated in current white-label implementation |
| `drizzle/meta/0002_snapshot.json` | adapt | replaced or consolidated in current white-label implementation |
| `drizzle/meta/0003_snapshot.json` | adapt | replaced or consolidated in current white-label implementation |
| `drizzle/meta/_journal.json` | adapt | retained/adapted |
| `frontend/api.ts` | keep | unchanged |
| `frontend/auth-client.ts` | adapt | retained/adapted |
| `frontend/components/ai-elements/artifact.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/canvas.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/chain-of-thought.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/checkpoint.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/code-block.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/confirmation.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/connection.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/context.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/controls.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/conversation.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/edge.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/image.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/inline-citation.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/loader.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/message.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/model-selector.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/node.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/open-in-chat.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/panel.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/plan.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/prompt-input.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/queue.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/reasoning.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/shimmer.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/sources.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/suggestion.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/task.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/tool.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ai-elements/toolbar.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ai-elements/web-preview.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/components/ui/accordion.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/alert-dialog.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/alert.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/avatar.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/badge.tsx` | keep | unchanged |
| `frontend/components/ui/breadcrumb.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/button-group.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/button.tsx` | keep | unchanged |
| `frontend/components/ui/calendar.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/card.tsx` | keep | unchanged |
| `frontend/components/ui/carousel.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/chart.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/checkbox.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/collapsible.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/command.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/copy-button.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/dialog.tsx` | keep | unchanged |
| `frontend/components/ui/drawer.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/dropdown-menu.tsx` | keep | unchanged |
| `frontend/components/ui/hover-card.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/input-group.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/input-otp.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/input.tsx` | keep | unchanged |
| `frontend/components/ui/label.tsx` | keep | unchanged |
| `frontend/components/ui/menubar.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/navigation-menu.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/pagination.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/popover.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/progress.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/radio-group.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/resizable.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/scroll-area.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/select.tsx` | keep | unchanged |
| `frontend/components/ui/separator.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/sheet.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/sidebar.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/skeleton.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/slider.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/switch.tsx` | keep | unchanged |
| `frontend/components/ui/table.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/tabs.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/textarea.tsx` | keep | unchanged |
| `frontend/components/ui/toggle-group.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/toggle.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/components/ui/tooltip.tsx` | keep | unchanged |
| `frontend/credentials-client.ts` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/env.ts` | adapt | retained/adapted |
| `frontend/global.d.ts` | keep | unchanged |
| `frontend/hooks/use-mobile.ts` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/index.html` | adapt | retained/adapted |
| `frontend/index.tsx` | keep | unchanged |
| `frontend/lib/utils.ts` | keep | unchanged |
| `frontend/public/anocca-logo.webp` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/public/favicon.png` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/router.ts` | keep | unchanged |
| `frontend/routes/__root.tsx` | adapt | retained/adapted |
| `frontend/routes/admin/analytics.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/routes/admin/cores.$coreId.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/routes/admin/cores.index.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/routes/admin/cores.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/routes/admin/index.tsx` | keep | unchanged |
| `frontend/routes/admin/models.tsx` | adapt | retained/adapted |
| `frontend/routes/admin/route.tsx` | adapt | retained/adapted |
| `frontend/routes/admin/settings.tsx` | adapt | retained/adapted |
| `frontend/routes/admin/users.$userId.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/routes/admin/users.index.tsx` | adapt | retained/adapted |
| `frontend/routes/admin/users.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/routes/chat/$id.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/routes/chat/index.tsx` | adapt | retained/adapted |
| `frontend/routes/chat/new.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/routes/index.tsx` | adapt | retained/adapted |
| `frontend/routes/knowledge-base/files/$.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/routes/knowledge-base/index.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/routes/models.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/routes/profile.tsx` | adapt | retained/adapted |
| `frontend/styles.css` | adapt | retained/adapted |
| `frontend/tsconfig.json` | keep | unchanged |
| `frontend/ui/analytics-charts.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/ui/analytics-controls.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/ui/analytics-summary-tables.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/ui/api-keys-modal.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/ui/chat-layout.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/ui/citation-pill.tsx` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `frontend/ui/components/message.tsx` | adapt | retained/adapted |
| `frontend/ui/components/reasoning.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/ui/mode-toggle.tsx` | keep | unchanged |
| `frontend/ui/model-deep-dive-table.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/ui/theme-provider.tsx` | keep | unchanged |
| `frontend/ui/usage-history-table.tsx` | adapt | replaced or consolidated in current white-label implementation |
| `frontend/ui/use-analytics-preferences.ts` | adapt | replaced or consolidated in current white-label implementation |
| `infra/build-image.sh` | adapt | replaced or consolidated in current white-label implementation |
| `infra/deploy-all.sh` | adapt | replaced or consolidated in current white-label implementation |
| `infra/deploy-app.sh` | adapt | replaced or consolidated in current white-label implementation |
| `infra/deploy-secrets.ts` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/app-deployment.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/app-service.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/configmap.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/docling-deployment.yaml` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `infra/kubectl/docling-service.yaml` | exclude | Anocca, RAG/documents, persistent chat, extensive tools, or customer asset |
| `infra/kubectl/ingress.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/namespace.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/postgres-init-configmap.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/postgres-service.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/postgres-sts.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/pvc.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/kubectl/secrets.yaml` | adapt | replaced or consolidated in current white-label implementation |
| `infra/push-image.sh` | adapt | replaced or consolidated in current white-label implementation |
| `infra/reload-app.sh` | adapt | replaced or consolidated in current white-label implementation |
| `infra/rollout-image.sh` | adapt | replaced or consolidated in current white-label implementation |
| `infra/shell-app.sh` | adapt | replaced or consolidated in current white-label implementation |
| `package.json` | adapt | retained/adapted |
| `patches/recharts@2.15.4.patch` | keep | unchanged |
| `scripts/generate-routes.ts` | keep | unchanged |
| `scripts/route-generator.ts` | keep | unchanged |
| `scripts/serve.ts` | adapt | retained/adapted |
| `shared/contract.ts` | adapt | retained/adapted |
| `shared/router-schema.ts` | keep | unchanged |
| `shared/types.ts` | adapt | replaced or consolidated in current white-label implementation |
| `tsconfig.json` | adapt | retained/adapted |

## Semantic diff log for fragile retained subsystems

- `backend/schema.ts`: replaces Anocca/core/RAG/conversation tables with the local/OIDC/trusted-header control plane and groups; preserves models, users, keys, append-only credit events; changes ledger key to `(id,time)`, removes historical FKs, and adds normal `usage_request_receipts` for global request idempotency compatible with Timescale partition rules.
- `backend/server.ts`: preserves the 255-second timeout, head/RPC dispatch, OpenAI endpoint, and all four historical native Bedrock compatibility routes; setup/control-plane gating replaces Anocca auth; RAG and persistent chat routes are excluded.
- `backend/router.ts`: retains models, users, groups, keys, ledger and every personal/system/user/group analytics dataset; `core` becomes `group`; management REST and the newer control-plane services remain authoritative for mutations.
- `backend/credit-service.ts`: preserves serialized finite/non-negative partial settlement and component costs; adds request/source/key metadata and exactly-once settlement receipts. The receipt and event write remain in the same transaction.
- `backend/bedrock.ts`: environment credentials become lazy, encrypted, database-owned, revision-aware clients; per-model region fallback remains.
- `backend/bedrock-proxy.ts`: historical InvokeModel, InvokeModelStream, Converse, and ConverseStream request transforms, raw streams, cache usage, cancellation, and billing are retained; auth uses shared `llmp_` principals and clients are dynamic.
- `backend/openai-proxy/handler.ts`: historical translation and streaming resilience remain; auth uses proxy principals, AWS clients are dynamic, model output limits are enforced, `reasoning_effort` maps to supported thinking budgets, and `X-Request-ID` enables retry idempotency.
- `backend/openai-proxy/transform/{cache-converse,cache-invoke,cache-usage,request,response,stream,utils}.ts`: SHA-256 hashes match `2140c21` byte-for-byte. `types.ts` only adds the supported `reasoning_effort` boundary.

## Deliberate product exclusions

Anocca clients/credentials/branding, core synchronization, Docling, documents, storage, embeddings, pgvector/RAG, citations, persistent/resumable conversations, attachments, and extensive tool/workflow UI belong outside this proxy. The retained chat route is a stateless model-testing playground. Historical customer deployment scripts and manifests are replaced by generic Compose and Helm workflows.

## Verification evidence

- Real `timescale/timescaledb:2.19.3-pg17` fresh migration creates the hypertable, 5m/1h/1d aggregates, refresh jobs, and compression policy.
- Real Timescale queries execute all retained analytics functions against sparse fixture data.
- Duplicate settlement with one request ID returns the original settlement, charges once, and writes one event.
- Transform fixture tests and hash comparison cover the unchanged OpenAI/Bedrock transformation core.
- `bun run typecheck`, `bun test`, Docker, Compose, Helm, and Kubernetes validations are the release gate listed in the active plan.
