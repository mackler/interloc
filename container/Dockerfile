# The image of the development container (compose.cc.yaml builds it as claude-code-base).
# It carries Claude Code, and the tools the test suite needs that npm does not provide:
# Playwright's Chromium, bashly (which generates bin/ilcli) and bats (which tests it).
# Their versions are pinned here, and the Node of the base image is the one .node-version gives CI;
# test/ci.test.ts checks all four against this machine, so that a rebuild cannot move them apart.

FROM node:26.10.0-trixie-slim
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

# The runtime hands an exec session umask 0000, so everything created inside the container lands
# world-writable (777 directories, 666 files) in the bind-mounted clone. 002 gives 775 and 664, which
# is what files created on the host already have. Git records only the executable bit, so this
# changes no committed mode; it keeps the working tree tidy.
RUN printf 'umask 002\n' >> /home/node/.bashrc \
 && printf 'umask 002\n' >> /home/node/.profile \
 && printf 'umask 002\n' > /home/node/.bashenv

# .bashrc is read only by an interactive shell and .profile only by a login shell, and `docker exec`
# gives neither: its shell is non-login and non-interactive, so it would keep the runtime's 0000.
# BASH_ENV is the file bash reads for a non-interactive shell, which covers `docker exec` and every
# command run through it.
ENV BASH_ENV=/home/node/.bashenv

# The developer's time zone, so that the clock in the container matches his own. TZ is set rather
# than /etc/localtime bind-mounted, because the two are not equivalent: glibc reads the file, but
# Node resolves /etc/localtime to a zone *name* and then uses ICU's own data, so a mounted file left
# `date` on CEST while node reported UTC. A name is what both agree on. Mounting the host's file also
# landed it on /usr/share/zoneinfo/Etc/UTC, the target the image's symlink resolves to, so `TZ=UTC`
# then reported Central European time. Interloq's records are unaffected either way: they are written
# with toISOString(), which is UTC whatever TZ says, and the page formats in the browser's zone.
ENV TZ=Europe/Prague

ENV CLAUDE_CONFIG_DIR=/home/node/.claude
ENV DISABLE_AUTOUPDATER=1
WORKDIR /workspace
CMD ["claude"]
