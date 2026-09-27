# The image of the development container (compose.cc.yaml builds it as claude-code-base).
# It carries Claude Code, and the tools the test suite needs that npm does not provide:
# Playwright's Chromium, bashly (which generates bin/ilcli) and bats (which tests it).
# Their versions are pinned here and checked against this machine and the CI workflow by
# test/ci.test.ts, so that a rebuild cannot silently move them apart.

FROM node:26-trixie-slim
ARG CLAUDE_CODE_VERSION=latest
ARG PLAYWRIGHT_VERSION=1.63.0
ARG BASHLY_VERSION=2.0.0
ARG BATS_VERSION=1.11.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep curl ca-certificates openssh-client less procps fish \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
RUN mkdir -p /home/node/.claude && chown node:node /home/node/.claude

# Playwright's Chromium and its system libraries, for Interloq's end-to-end tests.
# Runs as root, before USER node, because the libraries are installed with apt. The browser
# goes to a shared path so the node user finds it too; the version matches the @playwright/test
# pin in Interloq's package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* \
 && npm cache clean --force

# Ruby and bashly, which generate bin/ilcli from its configuration. bashly is pinned because an
# unpinned gem install would move on the next rebuild and part company with the workflow's version.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ruby ruby-dev build-essential \
 && gem install --no-document bashly -v ${BASHLY_VERSION} \
 && rm -rf /var/lib/apt/lists/*

# bats, for the tests of bin/ilcli (test/cli). From bats-core at the pinned tag, which is the source
# and the version the CI workflow installs, so that the two machines run the same bats.
RUN git clone --depth 1 --branch v${BATS_VERSION} https://github.com/bats-core/bats-core /tmp/bats-core \
 && /tmp/bats-core/install.sh /usr/local \
 && rm -rf /tmp/bats-core \
 && bats --version

USER node
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
ENV DISABLE_AUTOUPDATER=1
WORKDIR /workspace
CMD ["claude"]
