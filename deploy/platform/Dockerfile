# syntax=docker/dockerfile:1.7
#
# Built from the repository root, not deploy/platform, so the CLI is bundled
# from the same tree as the server it talks to. A client that can drift from
# its API is how the published npm package ended up three months behind a
# rewrite, still offering commands the platform had removed.

FROM minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3 AS mc

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS cli-builder
WORKDIR /cli
COPY cli/package.json cli/package-lock.json ./
RUN npm ci --ignore-scripts
COPY cli/tsconfig.json ./
COPY cli/src ./src
RUN npm run build:standalone

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder
WORKDIR /app
COPY deploy/platform/package.json deploy/platform/package-lock.json ./
RUN npm ci --ignore-scripts
COPY deploy/platform/tsconfig.json ./
COPY deploy/platform/src ./src
RUN npm run build

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ca-certificates docker-cli tar && mkdir -p /repo/cli
COPY --from=mc /usr/bin/mc /usr/local/bin/mc
COPY deploy/platform/package.json deploy/platform/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=cli-builder /cli/dist/ritsdev.cjs /repo/cli/ritsdev.cjs
EXPOSE 3000 3001
CMD ["node", "--enable-source-maps", "dist/server.js"]
