# Tacet HTTP API (`tacet serve`), read-only over an index the CLI fills from elsewhere, e.g. PostgreSQL / Supabase.
#   docker build -t tacet-api .
#   docker run -p 8000:8000 -e TACET_INDEX=postgresql://… -e TACET_API_TOKEN=… tacet-api

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ai-anthropic/package.json packages/ai-anthropic/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/extractor-java/package.json packages/extractor-java/
COPY packages/extractor-typescript/package.json packages/extractor-typescript/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages packages
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8000 TACET_READ_ONLY=true
COPY --from=build /app /app
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# TACET_INDEX (database URL) and TACET_API_TOKEN come from the environment; the token is required off loopback.
CMD ["node", "packages/cli/dist/bin.js", "serve", "--host", "0.0.0.0"]
