# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY whatsapp-sim/package.json whatsapp-sim/package-lock.json ./
RUN npm ci
COPY whatsapp-sim/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY whatsapp-sim/package.json ./
USER node
EXPOSE 4010
CMD ["node", "dist/main.js"]
