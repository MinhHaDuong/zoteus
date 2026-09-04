# syntax=docker/dockerfile:1
# Multi-stage build for the Zoteus MCP server (OAuth 2.1 remote).
FROM node:22-bookworm-slim AS build
WORKDIR /app
# --ignore-scripts: package.json has a `prepare` script (so a git-URL install
# builds itself), and this layer deliberately has no tsconfig.json or src/ yet.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Configure at deploy time (TLS is terminated by your proxy/tunnel in front of this):
#   ZOTERO_API_KEY=...                 (operator's Zotero key — single tenant)
#   ZOTEUS_OAUTH_ENABLED=true
#   ZOTEUS_PUBLIC_URL=https://<host>   (the public HTTPS origin claude.ai reaches)
#   ZOTEUS_OAUTH_PASSCODE=...          (>= 12 chars; `openssl rand -base64 24`)
#   ZOTEUS_READ_ONLY=true              (recommended for public connectors)
# Optional: ZOTEUS_ALLOWED_HOSTS=...   (extra Host values if your proxy rewrites Host)
#
# Multi-tenant (per-user Zotero accounts) instead of the single operator key:
#   ZOTEUS_OAUTH_MODE=zotero
#   ZOTERO_OAUTH_CLIENT_KEY=...  ZOTERO_OAUTH_CLIENT_SECRET=...  (https://www.zotero.org/oauth/apps)
#   ZOTEUS_OAUTH_STORE=file      ZOTEUS_OAUTH_TOKEN_SECRET=...   (openssl rand -base64 32)
#   ZOTEUS_DATA_DIR=/data        + mount a volume at /data so the encrypted store + indexes persist

VOLUME ["/data"]
EXPOSE 3939
ENTRYPOINT ["node", "dist/index.js", "--http", "--port", "3939", "--host", "0.0.0.0"]
