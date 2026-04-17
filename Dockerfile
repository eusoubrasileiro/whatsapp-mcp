# syntax=docker/dockerfile:1.7
# Build with BuildKit from whatsapp-mcp/:
#   docker build --build-context baileys=../baileys-client -t wa-mcp:latest .
#
# The `baileys` build context is the sibling baileys-client repo. pnpm's
# `link:../baileys-client` in package.json resolves to /app/baileys-client
# inside the image after the COPY steps below.
#
# We use node:22-slim (Debian) instead of alpine because better-sqlite3 ships
# prebuilt binaries for glibc but not musl — alpine would force a full native
# compile (+3-5min + python3/make/g++ in the build-deps stage).

# ── Stage 1: build @amiticia/baileys-client (needs dev deps for tsup) ──
FROM node:22-slim AS baileys-builder
WORKDIR /app/baileys-client
RUN corepack enable
COPY --from=baileys package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --from=baileys . ./
RUN pnpm build

# ── Stage 2: install whatsapp-mcp prod deps (better-sqlite3 uses prebuilt binary) ──
FROM node:22-slim AS whatsapp-deps
WORKDIR /app
RUN corepack enable
COPY --from=baileys-builder /app/baileys-client /app/baileys-client
WORKDIR /app/whatsapp-mcp
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Stage 3: runtime ──
FROM node:22-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini wget ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/whatsapp-mcp

# Bring over the linked baileys-client + whatsapp-mcp node_modules (incl. better-sqlite3 native binding).
COPY --from=whatsapp-deps /app/baileys-client /app/baileys-client
COPY --from=whatsapp-deps /app/whatsapp-mcp/node_modules ./node_modules
COPY --from=whatsapp-deps /app/whatsapp-mcp/package.json ./package.json

# Source for --experimental-strip-types runtime.
COPY src ./src
COPY tsconfig.json ./tsconfig.json
COPY scripts ./scripts

ENV NODE_ENV=production \
    MCP_TRANSPORT=httpstream \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=39001 \
    MCP_ENDPOINT=/mcp \
    QR_SERVER_HOST=0.0.0.0 \
    QR_SERVER_PORT=39002 \
    WHATSAPP_MCP_DATA_DIR=/data \
    LOG_LEVEL=info

EXPOSE 39001 39002
VOLUME ["/data"]

# Health check hits the public QR server (no Bearer required).
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s \
  CMD wget -qO- http://127.0.0.1:39002/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "src/main.ts"]
