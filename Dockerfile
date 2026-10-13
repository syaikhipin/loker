# career-ops-saas production image.
# Same image runs the API, the worker, and the scan-trigger cron (different CMD).
# Sized for small hosts: chromium HEADLESS SHELL only (no full desktop build),
# no LaTeX, no Go toolchain — the SaaS backend needs none of them.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CAREER_OPS_HOME=/opt/career-ops

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 # Chromium headless-shell only: our launches are all headless, and the full
 # desktop build (~364MB) would never start. --with-deps pulls the OS libs.
 && npx --yes playwright@1.64.0 install --only-shell chromium --with-deps \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# career-ops core (public repo). Pin CAREER_OPS_REF to a tag for production.
ARG CAREER_OPS_REF=main
RUN git clone --depth 1 --branch ${CAREER_OPS_REF} https://github.com/career-ops-hq/career-ops /opt/career-ops \
 && cd /opt/career-ops && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund

COPY . ./

EXPOSE 3000
# Render / compose override this per service:
CMD ["node", "api/server.mjs"]
