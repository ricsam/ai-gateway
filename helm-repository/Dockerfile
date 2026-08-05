FROM alpine/helm:3.21.3 AS builder

ARG REPOSITORY_URL
WORKDIR /workspace
COPY charts/llm-proxy ./charts/llm-proxy
RUN test -n "$REPOSITORY_URL" \
    && mkdir -p /repository \
    && helm package ./charts/llm-proxy --destination /repository \
    && helm repo index /repository --url "$REPOSITORY_URL"

FROM nginxinc/nginx-unprivileged:1.28.0-alpine
COPY helm-repository/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repository /usr/share/nginx/html
EXPOSE 8080
