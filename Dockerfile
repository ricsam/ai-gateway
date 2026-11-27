FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN bun run routes:generate && bun run typecheck

FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b AS runtime
LABEL org.opencontainers.image.title="AI Gateway" \
      org.opencontainers.image.description="OpenAI-compatible AI gateway for AWS Bedrock" \
      org.opencontainers.image.source="https://github.com/ricsam/ai-gateway" \
      org.opencontainers.image.documentation="https://ricsam.github.io/ai-gateway"
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
# The audio endpoints decode everything but PCM WAV with ffmpeg (backend/audio/ffmpeg.ts).
RUN apk add --no-cache ffmpeg
COPY --from=build --chown=bun:bun /app /app
# The management CLI: kubectl exec deploy/<release>-ai-gateway -- aigctl --help
RUN chmod 0755 /app/bin/aigctl && ln -s /app/bin/aigctl /usr/local/bin/aigctl
USER bun
EXPOSE 3000
CMD ["bun", "scripts/serve.ts", "--host", "0.0.0.0", "--port", "3000", "--production"]
