FROM node:22.23.1-alpine3.23@sha256:8516dce0483394d5708d4b2ee6cacb79fb1d617ea4e2787c2120bcca92ce372e AS node-base

FROM node-base AS builder

ENV NPM_CONFIG_IGNORE_PNPMFILE=true \
    NPM_CONFIG_IGNORE_SCRIPTS=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /workspace

RUN corepack enable \
    && corepack prepare pnpm@10.30.3 --activate \
    && test "$(pnpm --version)" = "10.30.3"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/update-server/package.json apps/update-server/package.json

RUN pnpm install \
    --filter @clodex/update-server... \
    --frozen-lockfile \
    --ignore-pnpmfile \
    --ignore-scripts

COPY apps/update-server/tsconfig.json apps/update-server/tsconfig.json
COPY apps/update-server/src apps/update-server/src

RUN pnpm --filter @clodex/update-server build \
    && pnpm --config.inject-workspace-packages=true \
      --filter @clodex/update-server \
      deploy \
      --prod \
      /opt/update-server \
    && rm -f \
      /opt/update-server/pnpm-lock.yaml \
      /opt/update-server/node_modules/.pnpm-workspace-state-v1.json \
    && rm -rf \
      /opt/update-server/node_modules/.bin \
      /opt/update-server/node_modules/.pnpm \
    && test -f /opt/update-server/dist/index.js \
    && test -f /opt/update-server/package.json \
    && test ! -e /opt/update-server/pnpm-lock.yaml \
    && test ! -e /opt/update-server/src \
    && test ! -e /opt/update-server/node_modules/typescript \
    && test ! -e /opt/update-server/node_modules/vitest

FROM node-base AS runtime

ARG TARGETARCH

ENV GH_PROMPT_DISABLED=1 \
    NODE_ENV=production \
    NO_COLOR=1 \
    PORT=3000

WORKDIR /app

COPY apps/update-server/deploy-toolchain.json /tmp/deploy-toolchain.json

RUN set -eux; \
    architecture="${TARGETARCH:-$(uname -m)}"; \
    case "$architecture" in \
      amd64|x86_64) architecture=amd64 ;; \
      arm64|aarch64) architecture=arm64 ;; \
      *) echo "Unsupported GitHub CLI architecture: $architecture" >&2; exit 1 ;; \
    esac; \
    gh_version="$(node -p "require('/tmp/deploy-toolchain.json').githubCli.version")"; \
    gh_base_url="$(node -p "require('/tmp/deploy-toolchain.json').githubCli.sourceBaseUrl")"; \
    gh_archive="$(node -p "require('/tmp/deploy-toolchain.json').githubCli.archives['$architecture'].file")"; \
    gh_sha256="$(node -p "require('/tmp/deploy-toolchain.json').githubCli.archives['$architecture'].sha256")"; \
    wget -O /tmp/gh.tar.gz "$gh_base_url/$gh_archive"; \
    test "$(sha256sum /tmp/gh.tar.gz | awk '{ print $1 }')" = "$gh_sha256"; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    cp "/tmp/gh_${gh_version}_linux_${architecture}/bin/gh" /usr/local/bin/gh; \
    chmod 0755 /usr/local/bin/gh; \
    test "$(gh version | awk 'NR == 1 { print $3 }')" = "$gh_version"; \
    gh attestation verify --help >/tmp/gh-attestation-help.txt; \
    node -e 'const fs=require("node:fs");const p=require("/tmp/deploy-toolchain.json");const h=fs.readFileSync("/tmp/gh-attestation-help.txt","utf8");for(const f of p.githubCli.requiredAttestationFlags){if(!h.includes(f))throw new Error(`missing GitHub CLI attestation flag: ${f}`)}'; \
    rm -rf \
      /tmp/deploy-toolchain.json \
      /tmp/gh-attestation-help.txt \
      /tmp/gh.tar.gz \
      "/tmp/gh_${gh_version}_linux_${architecture}"

COPY --from=builder --chown=node:node /opt/update-server/ /app/

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
