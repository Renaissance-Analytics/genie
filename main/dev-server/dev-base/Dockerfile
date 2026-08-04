# syntax=docker/dockerfile:1
#
# genie-dev-base — the ONE workspace dev image (Tynn #234, P2 of the dev server).
#
# `main/dev-server/images.ts` explains WHY there is one multi-language image
# rather than a per-stack image pulled on demand: the sandbox boundary is the
# WORKSPACE, and a workspace routinely holds a Node frontend, a PHP API and a
# Python worker at once. This file is the other half of that decision — the
# contents.
#
# Two properties this file exists to hold:
#
#   * **Reproducible.** The consumer pins `:1` (never `:latest`) because a
#     workspace's toolchain must not change under it on a restart. So every
#     toolchain here is a pinned version fetched from its vendor and verified
#     against that vendor's published checksum. Bumping one is a build-arg edit,
#     not a rebuild lottery.
#
#   * **Writes files as the HOST user.** The workspace directory is bind-mounted
#     in. On Linux a container writing as uid 0 leaves root-owned files in the
#     user's own repo, which they then cannot delete. See the uid/gid section
#     near the bottom — the whole entrypoint dance exists for that one sentence.
#
# Built and published ONLY by `.github/workflows/dev-base-image.yml`, on a
# `dev-base-v*` tag. Never on a branch push — see `README.md`.

# Debian rather than Alpine: this image compiles things (node-gyp, cargo, cgo,
# psycopg, PHP PECL builds), and glibc + Debian's -dev packages are what those
# expect. musl saves a few hundred MB and costs a support channel.
#
# `trixie` (Debian 13) is the pin that fixes PHP at 8.4 and Python at 3.13 —
# those two come from apt, so the base tag IS their version pin. Bumping the
# base is what bumps them.
FROM debian:trixie-slim

# Fail a pipeline on the FIRST command that fails, not just the last. Without
# this, `curl ... | jq` silently succeeds when curl 404s.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

LABEL org.opencontainers.image.source="https://github.com/Renaissance-Analytics/genie" \
      org.opencontainers.image.title="genie-dev-base" \
      org.opencontainers.image.description="Multi-language workspace dev image for the Genie dev server (Node, PHP, Python, Go, Rust)." \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"

# --- versions ---------------------------------------------------------------
#
# Every one of these is overridable at build time (`--build-arg GO_VERSION=...`)
# so a bump is one line here and one line in the workflow, and so a bad pin can
# be bisected without editing the Dockerfile.

# Node 24 = Active LTS (24 is LTS until Oct 2026, maintenance to Apr 2028).
# Pinned by MAJOR, not patch: nodejs.org publishes a `latest-v24.x` channel with
# a checksum file, so the exact build is resolved-then-verified rather than
# guessed, and a security patch does not need a commit here.
ARG NODE_MAJOR=24
ARG PNPM_VERSION=11.18.0
ARG YARN_VERSION=1.22.22
ARG COMPOSER_MAJOR=2
ARG UV_VERSION=0.12.1
ARG GO_VERSION=1.26.5
ARG RUST_VERSION=1.97.1

# The uid/gid the `genie` user is BUILT with. 1000 because that is the first
# human user on essentially every Linux desktop, so the common case needs no
# runtime adjustment at all. See "uid/gid matching" below for the other cases.
ARG GENIE_UID=1000
ARG GENIE_GID=1000

# ARG, not ENV. `DEBIAN_FRONTEND=noninteractive` is right for a build and WRONG
# for the image: a developer running `sudo apt install` inside their own sandbox
# should get the prompts, not have them silently answered. ARG reaches every RUN
# below and is gone from the finished image.
ARG DEBIAN_FRONTEND=noninteractive

# LANG only. `LC_ALL` overrides every other locale setting including the user's
# own, which is not this image's call to make.
ENV LANG=C.UTF-8

# --- system packages --------------------------------------------------------
#
# Deliberately unpinned apt versions: the `debian:trixie` tag is the pin. Debian
# stable only moves these for security fixes within the same upstream version,
# and pinning `php-cli=2:8.4+96` here would break the build the day a point
# release lands while changing nothing about what is installed.
# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        default-libmysqlclient-dev \
        git \
        git-lfs \
        gnupg \
        jq \
        less \
        libpq-dev \
        libssl-dev \
        openssh-client \
        pkg-config \
        procps \
        rsync \
        sqlite3 \
        sudo \
        tar \
        unzip \
        xz-utils \
        zip \
        \
        python3 \
        python3-dev \
        python3-venv \
        python3-pip \
        python-is-python3 \
        pipx \
        \
        php-cli \
        php-bcmath \
        php-curl \
        php-gd \
        php-intl \
        php-mbstring \
        php-mysql \
        php-pgsql \
        php-redis \
        php-sqlite3 \
        php-xml \
        php-zip \
    ; \
    rm -rf /var/lib/apt/lists/*; \
    php --version; \
    python3 --version

# --- Node + package managers ------------------------------------------------
#
# Official nodejs.org tarball rather than the NodeSource apt repo: one URL for
# both architectures, a checksum file published beside it, and no third-party
# apt key to rotate.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) node_arch='x64' ;; \
        arm64) node_arch='arm64' ;; \
        *) echo "genie-dev-base: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    channel="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/SHASUMS256.txt" "${channel}/SHASUMS256.txt"; \
    file="$(awk -v a="${node_arch}" '$2 ~ ("^node-v.*-linux-" a "\\.tar\\.xz$") { print $2 }' "${tmp}/SHASUMS256.txt")"; \
    test -n "${file}"; \
    curl -fsSL -o "${tmp}/${file}" "${channel}/${file}"; \
    want="$(awk -v f="${file}" '$2 == f { print $1 }' "${tmp}/SHASUMS256.txt")"; \
    got="$(sha256sum "${tmp}/${file}" | cut -d' ' -f1)"; \
    test -n "${want}"; \
    test "${want}" = "${got}"; \
    tar -xJf "${tmp}/${file}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -rf "${tmp}" /usr/local/CHANGELOG.md /usr/local/LICENSE /usr/local/README.md; \
    node --version; \
    npm --version

# pnpm and yarn are installed as REAL global packages rather than via
# `corepack enable`. Corepack's shims resolve the version from a repo's
# `packageManager` field and DOWNLOAD it on first use — which turns "run the dev
# server" into a network call that can fail or prompt. A repo that genuinely
# needs an exact pnpm runs `sudo corepack enable` itself; everyone else gets a
# working `pnpm` with no network at all.
RUN set -eux; \
    npm install -g --no-audit --no-fund "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}"; \
    npm cache clean --force; \
    pnpm --version; \
    yarn --version

# --- Composer ---------------------------------------------------------------
#
# The only download here with real PROVENANCE rather than just integrity: the
# installer's sha384 is published on a different origin (composer.github.io) to
# the installer itself (getcomposer.org), so a compromise of one does not pass
# the check.
RUN set -eux; \
    curl -fsSL -o /tmp/composer-setup.php https://getcomposer.org/installer; \
    expected="$(curl -fsSL https://composer.github.io/installer.sig)"; \
    actual="$(php -r 'echo hash_file("sha384", "/tmp/composer-setup.php");')"; \
    test "${expected}" = "${actual}"; \
    php /tmp/composer-setup.php "--${COMPOSER_MAJOR}" --install-dir=/usr/local/bin --filename=composer; \
    rm -f /tmp/composer-setup.php; \
    composer --version

# --- Python: uv -------------------------------------------------------------
#
# Debian's python3 is PEP 668 "externally managed", so a bare `pip install`
# refuses. uv (and pipx, from apt above) are the sanctioned ways in, and uv is
# the one projects actually pin their lockfiles to.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) triple='x86_64-unknown-linux-gnu' ;; \
        arm64) triple='aarch64-unknown-linux-gnu' ;; \
        *) echo "genie-dev-base: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}"; \
    file="uv-${triple}.tar.gz"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/${file}" "${base}/${file}"; \
    want="$(curl -fsSL "${base}/${file}.sha256" | cut -d' ' -f1)"; \
    got="$(sha256sum "${tmp}/${file}" | cut -d' ' -f1)"; \
    test -n "${want}"; \
    test "${want}" = "${got}"; \
    tar -xzf "${tmp}/${file}" -C "${tmp}"; \
    install -m 0755 "${tmp}/uv-${triple}/uv" "${tmp}/uv-${triple}/uvx" /usr/local/bin/; \
    rm -rf "${tmp}"; \
    uv --version

# --- Go ---------------------------------------------------------------------
#
# go.dev/dl publishes a JSON index carrying the sha256 of every archive, so the
# checksum comes from the vendor's metadata rather than from the tarball's own
# neighbour file.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
        amd64|arm64) ;; \
        *) echo "genie-dev-base: unsupported architecture ${arch}" >&2; exit 1 ;; \
    esac; \
    file="go${GO_VERSION}.linux-${arch}.tar.gz"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/${file}" "https://go.dev/dl/${file}"; \
    want="$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' | jq -r --arg f "${file}" 'map(.files[]) | map(select(.filename == $f)) | first | .sha256')"; \
    got="$(sha256sum "${tmp}/${file}" | cut -d' ' -f1)"; \
    test -n "${want}"; \
    test "${want}" != "null"; \
    test "${want}" = "${got}"; \
    tar -xzf "${tmp}/${file}" -C /usr/local --no-same-owner; \
    rm -rf "${tmp}"; \
    /usr/local/go/bin/go version

# --- Rust -------------------------------------------------------------------
#
# RUSTUP_HOME and CARGO_HOME live under /usr/local rather than the user's home
# so that the ~1.5 GB toolchain is NOT part of the tree the uid-alignment
# entrypoint has to `chown -R`. CARGO_HOME is made world-writable (as the
# official rust image does) because cargo writes its registry cache there; the
# toolchain itself stays root-owned and read-only.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) triple='x86_64-unknown-linux-gnu' ;; \
        arm64) triple='aarch64-unknown-linux-gnu' ;; \
        *) echo "genie-dev-base: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    base="https://static.rust-lang.org/rustup/dist/${triple}"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/rustup-init" "${base}/rustup-init"; \
    want="$(curl -fsSL "${base}/rustup-init.sha256" | cut -d' ' -f1)"; \
    got="$(sha256sum "${tmp}/rustup-init" | cut -d' ' -f1)"; \
    test -n "${want}"; \
    test "${want}" = "${got}"; \
    chmod +x "${tmp}/rustup-init"; \
    "${tmp}/rustup-init" -y --no-modify-path --profile minimal \
        --default-toolchain "${RUST_VERSION}" \
        --component rustfmt --component clippy; \
    rm -rf "${tmp}"; \
    chmod -R a+w "${CARGO_HOME}"; \
    "${CARGO_HOME}/bin/rustc" --version; \
    "${CARGO_HOME}/bin/cargo" --version

# --- Caddy ------------------------------------------------------------------
#
# The per-workspace reverse proxy that fronts every hosted `.gen` site. It runs
# INSIDE this sandbox alongside the app processes, publishes ONE https port,
# TLS-terminates each `<name>.gen` (forcing https), and reverse-proxies to the
# app's plain-http loopback port (masking it). Pinned + checksum-verified against
# the release's own `checksums.txt` — same trust model as Go/Rust above, no
# runtime download.
ARG CADDY_VERSION=2.8.4
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) arch='amd64' ;; \
        arm64) arch='arm64' ;; \
        *) echo "genie-dev-base: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}"; \
    file="caddy_${CADDY_VERSION}_linux_${arch}.tar.gz"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "${tmp}/${file}" "${base}/${file}"; \
    want="$(curl -fsSL "${base}/caddy_${CADDY_VERSION}_checksums.txt" | grep " ${file}\$" | cut -d' ' -f1)"; \
    got="$(sha256sum "${tmp}/${file}" | cut -d' ' -f1)"; \
    test -n "${want}"; \
    test "${want}" = "${got}"; \
    tar -xzf "${tmp}/${file}" -C "${tmp}" caddy; \
    install -m 0755 "${tmp}/caddy" /usr/local/bin/caddy; \
    rm -rf "${tmp}"; \
    caddy version

# --- the genie user ---------------------------------------------------------
#
# Everything a workspace runs happens as `genie`, never as root. The uid is
# 1000 at build time and RENUMBERED at start when the host says otherwise —
# see the entrypoint contract below.
#
# The delete-first guard is not paranoia: Debian and Ubuntu base images have
# both, at different times, shipped a pre-made uid-1000 user. Without this the
# `useradd` fails and the whole build dies on a base-image refresh.
#
# The delete is TOLERATED, not asserted. `userdel -r` exits 12 when the account
# had no home directory to remove even though it DID remove the account, and the
# retry then fails with "user does not exist" — a false failure. If the delete
# genuinely did not work, the `groupadd`/`useradd` below say so unambiguously.
RUN set -eux; \
    if existing="$(getent passwd "${GENIE_UID}" | cut -d: -f1)" && [ -n "${existing}" ]; then \
        userdel -r "${existing}" || userdel "${existing}" || true; \
    fi; \
    if existing="$(getent group "${GENIE_GID}" | cut -d: -f1)" && [ -n "${existing}" ]; then \
        groupdel "${existing}" || true; \
    fi; \
    groupadd --gid "${GENIE_GID}" genie; \
    useradd --uid "${GENIE_UID}" --gid "${GENIE_GID}" --create-home --shell /bin/bash genie; \
    printf 'genie ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/genie; \
    chmod 0440 /etc/sudoers.d/genie; \
    visudo -c; \
    install -d -m 0755 -o genie -g genie /workspace

# Per-user tool state, all under /home/genie so that ONE `chown -R` in the
# entrypoint covers every cache a renumbered user needs to own. The expensive
# trees (Go's GOROOT, Rust's toolchain, node's /usr/local) are deliberately
# NOT here.
ENV GOROOT=/usr/local/go \
    GOPATH=/home/genie/go \
    NPM_CONFIG_PREFIX=/home/genie/.npm-global \
    PNPM_HOME=/home/genie/.local/share/pnpm \
    COMPOSER_HOME=/home/genie/.composer \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PATH=/home/genie/.npm-global/bin:/home/genie/.local/share/pnpm:/home/genie/.local/bin:/home/genie/go/bin:/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN set -eux; \
    install -d -m 0755 -o genie -g genie \
        /home/genie/.npm-global \
        /home/genie/.local/share/pnpm \
        /home/genie/.local/bin \
        /home/genie/.composer \
        /home/genie/.cache \
        /home/genie/go

# Debian's /etc/profile HARD-ASSIGNS PATH rather than extending it, so any login
# shell — `docker exec -it … bash -l`, anything that shells out through
# `sh -lc` — throws away everything the ENV above put there and reports
# "go: command not found" in an image that plainly has Go. The drop-in runs
# after that assignment and puts the toolchains back.
RUN set -eux; \
    { \
        echo '# Restore the toolchain PATH that /etc/profile just overwrote.'; \
        echo 'PATH="/home/genie/.npm-global/bin:/home/genie/.local/share/pnpm:/home/genie/.local/bin:/home/genie/go/bin:/usr/local/go/bin:/usr/local/cargo/bin:${PATH}"'; \
        echo 'export PATH'; \
    } > /etc/profile.d/10-genie-toolchains.sh; \
    chmod 0644 /etc/profile.d/10-genie-toolchains.sh

# --- uid/gid matching -------------------------------------------------------
#
# The problem: on Linux, a bind mount carries no ownership translation. A
# container process writing to /workspace writes with ITS numeric uid, and if
# that is not the host user's uid the files land unowned — `npm install` inside
# the sandbox produces a node_modules the user cannot delete. (On Docker Desktop
# for macOS/Windows the VM translates ownership and none of this applies.)
#
# The fix: pass HOST_UID / HOST_GID as container env. `genie-entrypoint` then
# renumbers the `genie` user to match BEFORE anything runs.
#
# Why renumbering rather than `--user 1234:1234`:
#
#   * `--user` with a bare numeric id gives a process with no passwd entry —
#     no name, no $HOME, no shell. Tools that read the passwd database (git,
#     ssh, anything that resolves `~`) misbehave in ways that are miserable to
#     diagnose.
#   * `ContainerSpec` (P1's `container-runtime.ts`) has no `user` field but DOES
#     have `env`, so this needs no P1 change to wire up.
#   * `docker exec` / `podman exec` resolve the image's `USER genie` against the
#     CONTAINER's /etc/passwd at exec time, not against the image's. Because the
#     entrypoint has already rewritten that file in the container's own layer,
#     every later exec — which is how P2 starts dev servers — lands on the
#     renumbered uid automatically. That is the whole trick.
#
# The entrypoint runs as `genie` (so that the default, no-env case needs no
# privilege at all) and shells out to a root helper via sudo only when there is
# actually a mismatch to fix.
#
# `--chmod` needs BuildKit, which is the default for `docker build` and required
# for the buildx multi-arch build in CI.
COPY --chmod=0755 entrypoint.sh /usr/local/bin/genie-entrypoint
COPY --chmod=0755 align-uid.sh /usr/local/sbin/genie-align-uid

USER genie
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/genie-entrypoint"]

# A dev container that exits the moment it is created is not a sandbox — the
# repos' dev servers are started LATER, with `exec`, into a container that is
# already up. `tail -f /dev/null` rather than `sleep infinity` for the reason
# `images.ts#DEV_CONTAINER_HOLD_COMMAND` gives, and it is the same argv so that
# `docker run genie-dev-base` on its own behaves like the sandbox does.
CMD ["tail", "-f", "/dev/null"]
