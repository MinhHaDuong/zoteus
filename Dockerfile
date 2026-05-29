# syntax=docker/dockerfile:1
# Multi-stage build for the Zoteus MCP server (OAuth 2.1 remote).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

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
EXPOSE 3939
ENTRYPOINT ["node", "dist/index.js", "--http", "--port", "3939", "--host", "0.0.0.0"]
