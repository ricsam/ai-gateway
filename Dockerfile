FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN bun run routes:generate && bun run typecheck

FROM oven/bun:1.3.14-alpine AS runtime
LABEL org.opencontainers.image.title="AI Gateway" \
      org.opencontainers.image.description="OpenAI-compatible AI gateway for AWS Bedrock" \
      org.opencontainers.image.source="https://github.com/ricsam/ai-gateway" \
      org.opencontainers.image.documentation="https://ricsam.github.io/ai-gateway"
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=bun:bun /app /app
USER bun
EXPOSE 3000
CMD ["bun", "scripts/serve.ts", "--host", "0.0.0.0", "--port", "3000", "--production"]
