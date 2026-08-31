# syntax=docker/dockerfile:1.7

# The official Playwright image ships the browsers under /ms-playwright but not
# the `playwright` npm package, so the render script's require('playwright')
# fails with "Cannot find module". Layer the matching package version onto the
# pinned base and skip the browser download, since the base already has them.
FROM mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_PATH=/usr/lib/node_modules

RUN npm install -g --no-audit --no-fund playwright@1.60.0 \
    && node -e "require('playwright')" \
    && npm cache clean --force
