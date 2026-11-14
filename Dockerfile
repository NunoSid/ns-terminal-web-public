FROM oven/bun:1.4.3-alpine
WORKDIR /app
COPY server/package.json ./server/package.json
RUN cd server && bun install --production || true
COPY server ./server
RUN mkdir -p /app/web
COPY web* ./web/
ENV PORT=8787 WEB_ROOT=/app/web
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["bun", "run", "server/index.js"]
