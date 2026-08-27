FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV FIRSTMEASURE_PDF_BROWSER=/usr/bin/chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/public/v1

COPY public/v1/package.json public/v1/package-lock.json ./
RUN npm ci --include=dev

WORKDIR /app
COPY public ./public
WORKDIR /app/public/v1
RUN npm run build && npm prune --omit=dev

EXPOSE 3101
CMD ["node", "--experimental-sqlite", "dist/src/server.js"]
