FROM oven/bun:1.4.3-alpine
WORKDIR /app
RUN apk add --no-cache curl tar
COPY server/package.json ./server/package.json
RUN cd server && bun install --production || true
COPY server ./server
# Frontend bundle is published as a release asset (too large for a normal git tree).
ARG WEB_BUNDLE_URL=https://github.com/NunoSid/ns-terminal-web-public/releases/download/v1/web.tar.gz
RUN mkdir -p /app/web && curl -fsSL "$WEB_BUNDLE_URL" -o /tmp/web.tar.gz && tar -xzf /tmp/web.tar.gz -C /app/web && rm /tmp/web.tar.gz
ENV PORT=8787 WEB_ROOT=/app/web
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["bun", "run", "server/index.js"]
