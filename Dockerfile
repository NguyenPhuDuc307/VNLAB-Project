# VNLab Project: một tiến trình Node vừa phục vụ API vừa phục vụ SPA đã build.
# Server viết bằng TypeScript chạy thẳng nhờ type stripping của Node 24 —
# không có bước biên dịch server.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
# Mã bookmarklet Getfly do server phục vụ ở /bm/*.js (tệp TS thuần, không import gì).
COPY src/lib/getfly-bookmarklet.ts src/lib/getfly-kpi-bookmarklet.ts ./src/lib/
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3400
CMD ["node", "server/index.ts"]
