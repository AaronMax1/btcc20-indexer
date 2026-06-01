FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    BTCC20_VIEWER_HOST=0.0.0.0 \
    BTCC20_VIEWER_PORT=8798 \
    BTCC20_INDEX_FILE=/data/index-state.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.mjs ./
COPY public ./public
COPY data/.gitignore ./data/.gitignore

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8798

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.BTCC20_VIEWER_PORT || 8798) + '/api/index/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
