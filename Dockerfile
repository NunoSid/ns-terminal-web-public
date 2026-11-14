FROM oven/bun:1.4.3-alpine
WORKDIR /app
RUN apk add --no-cache curl tar
COPY server/package.json ./server/package.json
RUN cd server && bun install --production || true
COPY server ./server
# Frontend + sidecar bundle live in a separate repo and are fetched at build time.
# Pinned to a commit: Docker caches this layer by the expanded command, so bumping
# the ref is what actually invalidates the cache (a branch name never changes).
ARG WEB_ASSETS_REF=18bb02007e0568988a3ede37ef2028aedfba5b11
RUN mkdir -p /app/web /app/sidecar && \
    curl -fsSL "https://github.com/NunoSid/ns-terminal-web-assets/archive/${WEB_ASSETS_REF}.tar.gz" -o /tmp/assets.tar.gz && \
    tar -xzf /tmp/assets.tar.gz -C /tmp && \
    cp -r /tmp/ns-terminal-web-assets-*/web/. /app/web/ && \
    cp -r /tmp/ns-terminal-web-assets-*/sidecar/. /app/sidecar/ && \
    rm -rf /tmp/assets.tar.gz /tmp/ns-terminal-web-assets-*
ENV PORT=8787 WEB_ROOT=/app/web
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["bun", "run", "server/index.js"]
