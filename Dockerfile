FROM oven/bun:1.4.3-alpine
WORKDIR /app
RUN apk add --no-cache curl tar
COPY server/package.json ./server/package.json
RUN cd server && bun install --production || true
COPY server ./server
# Frontend bundle lives in a separate repo and is fetched at build time.
ARG WEB_ASSETS_REF=main
RUN mkdir -p /app/web && \
    curl -fsSL "https://github.com/NunoSid/ns-terminal-web-assets/archive/refs/heads/${WEB_ASSETS_REF}.tar.gz" -o /tmp/web.tar.gz && \
    tar -xzf /tmp/web.tar.gz -C /tmp && \
    cp -r /tmp/ns-terminal-web-assets-*/web/. /app/web/ && \
    rm -rf /tmp/web.tar.gz /tmp/ns-terminal-web-assets-*
ENV PORT=8787 WEB_ROOT=/app/web
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["bun", "run", "server/index.js"]
