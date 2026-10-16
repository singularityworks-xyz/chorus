# User-owned Chorus host images. Never run these on the connection relay.
FROM node:22-bookworm-slim AS dependencies
COPY --from=oven/bun:1.4.3 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run --cwd apps/web build

FROM node:22-bookworm-slim AS production-dependencies
COPY --from=oven/bun:1.4.3 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .
RUN bun install --production --frozen-lockfile --ignore-scripts \
    && bun docker/install-engine.ts

FROM node:22-bookworm-slim AS host-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 chorus \
    && useradd --uid 10001 --gid chorus --create-home chorus
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM host-base AS web
COPY --from=web-build --chown=10001:10001 /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=10001:10001 /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=10001:10001 /app/apps/web/public ./apps/web/public
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM host-base AS serve
COPY --from=dependencies /usr/local/bin/bun /usr/local/bin/bun
COPY --from=production-dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=10001:10001 /app/packages ./packages
COPY --from=production-dependencies --chown=10001:10001 /app/apps/serve ./apps/serve
COPY --from=production-dependencies --chown=10001:10001 /app/package.json ./package.json
ENV PORT=2000 CHORUS_BIND_ADDRESS=0.0.0.0 DATA_DIR=/data XDG_DATA_HOME=/data/xdg-data XDG_CONFIG_HOME=/data/xdg-config
WORKDIR /app/apps/serve
EXPOSE 2000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
    CMD bun -e 'const r = await fetch("http://127.0.0.1:" + (process.env.PORT || "2000") + "/health"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "src/index.ts"]
