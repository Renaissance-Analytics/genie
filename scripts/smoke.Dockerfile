# The image the smoke path runs in: Node, Xvfb, and Electron's shared libraries.
#
# Built once and cached by tag, because the apt install is the slow part and a verification
# that takes four minutes every time stops being run.
#
# Deliberately NOT a general-purpose dev image. It exists to open one window, prove the
# Dashboard is there, and be thrown away.
FROM node:22-bookworm-slim

# Electron is Chromium, and Chromium needs its graphics, font and a11y libraries present even
# when it renders to a virtual display. The list is long and every entry is load-bearing: a
# missing one fails at launch with a bare "error while loading shared libraries", which reads
# like a broken build rather than a missing package.
#
# `fontconfig` and a real proportional family are here for a reason that is not cosmetic. The
# slim image has no fontconfig aliases, so `sans-serif` resolves to whatever face happens to be
# first — which was a monospace one, and made the entire app render monospaced in the
# screenshot. That LOOKED exactly like the circular-`@theme` bug it was sitting next to, and
# telling the two apart needed a container whose fallback is meaningful.
#
# `xauth` is not optional either, and it is not obvious: `xvfb-run` shells out to it to create
# the display authority file. Without it the launch dies with "xauth command not found",
# Electron never starts, and the symptom is "the window never appeared on the debugger port" —
# which points at the harness rather than at the missing package. Measured, not recalled.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        xauth \
        libgtk-3-0 \
        libnotify4 \
        libnss3 \
        libxss1 \
        libxtst6 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libgbm1 \
        libasound2 \
        libpangocairo-1.0-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        fonts-liberation \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Make the container's font resolution representative of a desktop. See the comment inside
# `smoke-fonts.conf` for what was measured and why it matters.
COPY smoke-fonts.conf /etc/fonts/local.conf
RUN fc-cache -f >/dev/null

# Prime Electron's download cache at BUILD time.
#
# Every container run was re-downloading the ~110MB Electron binary, which made each smoke
# several minutes and made DEBUGGING one a slow loop — a cost of its own, because a check that
# is expensive to run is a check people stop running.
#
# The cache lives outside the project, so the `npm ci` inside each run finds it and skips the
# download. Pinned to the version `package.json` asks for: a cache primed with a different
# version silently does nothing, which is worse than no cache because it looks like one. The
# final `ls` fails the build if nothing landed, rather than shipping an image that quietly
# re-downloads forever.
ENV ELECTRON_CACHE=/opt/electron-cache
RUN mkdir -p /tmp/prime /opt/electron-cache \
    && cd /tmp/prime \
    && npm init -y >/dev/null 2>&1 \
    && npm install electron@44.7.0 --no-audit --no-fund >/dev/null 2>&1 \
    && rm -rf /tmp/prime \
    && ls -1 /opt/electron-cache | head -3

WORKDIR /work
