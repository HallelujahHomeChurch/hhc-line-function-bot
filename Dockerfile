FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim AS attachment-scan-worker
ARG CLAMAV_VERSION=1.4.3+dfsg-1~deb12u2
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      "clamav=${CLAMAV_VERSION}" \
      "clamav-base=${CLAMAV_VERSION}" \
      "clamav-freshclam=${CLAMAV_VERSION}" \
    && sed -i \
      's#^UpdateLogFile .*#UpdateLogFile /tmp/hhc-line-bot-freshclam.log#' \
      /etc/clamav/freshclam.conf \
    && grep -Fxq \
      'UpdateLogFile /tmp/hhc-line-bot-freshclam.log' \
      /etc/clamav/freshclam.conf \
    && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.source="https://github.com/HallelujahHomeChurch/hhc-line-function-bot"
LABEL org.opencontainers.image.description="Finite LINE attachment scan and signature refresh worker"
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config ./config
USER node
CMD ["node", "dist/tools/run-attachment-scan-job.js"]

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/HallelujahHomeChurch/hhc-line-function-bot"
LABEL org.opencontainers.image.description="LINE function bot with local-first LLM routing"
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config ./config
EXPOSE 3000
CMD ["dist/index.js"]
