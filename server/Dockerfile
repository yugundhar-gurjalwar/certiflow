# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (see docker-compose.yml) because the test-suite imports the WhatsApp
# stand-in from ../whatsapp-sim.

FROM node:22-alpine AS build
WORKDIR /repo/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY whatsapp-sim/src /repo/whatsapp-sim/src
COPY server/ ./
RUN npm run build

# `docker compose --profile test run --rm test` uses this stage (needs dev dependencies + test sources).
FROM build AS test
ENV NODE_ENV=test
CMD ["npx", "vitest", "run"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /repo/server/dist ./dist
COPY server/drizzle ./drizzle
RUN mkdir -p /data/certificates && chown -R node:node /data /app
USER node
ENV STORAGE_DIR=/data/certificates
EXPOSE 4000 4001
CMD ["node", "dist/api.js"]
