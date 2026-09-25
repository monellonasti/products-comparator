# syntax=docker/dockerfile:1.7
# One image for both processes: API/web (default CMD) and worker (command override).
# Base: Debian bookworm (glibc) because onnxruntime-node and sharp ship glibc binaries for linux x64/arm64.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 VISION_CACHE_DIR=/app/.models UV_THREADPOOL_SIZE=8
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod
COPY src ./src
COPY migrations ./migrations
COPY --from=build /app/dist ./dist
RUN groupadd --system app && useradd --system --gid app --home /app app && mkdir -p /app/.models && chown -R app:app /app/.models
USER app
# Optional: bake the model weights into the image (pinned revision) instead of downloading at first start.
ARG PREFETCH_MODEL=false
RUN if [ "$PREFETCH_MODEL" = "true" ]; then DATABASE_URL=postgres://unused@localhost/unused node src/scripts/model-download.ts; fi
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server/index.ts"]
