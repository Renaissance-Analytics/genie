# genie-dev-base

The **one** image every Genie workspace's dev container runs.

```
ghcr.io/renaissance-analytics/genie-dev-base:1
```

`main/dev-server/images.ts` explains the decision this image is the other half
of: the sandbox boundary is the **workspace**, not the repo, and a workspace
routinely holds a Node frontend, a PHP API and a Python worker at once. Per-stack
images would mean three dev containers over one directory, or picking a "primary"
stack per workspace — which is exactly the PHP-first mistake the beta.218 hosting
runtime made. One image is bigger to pull once and simpler forever.

---

## What's in it

Base: **Debian 13 (trixie), slim.** Not Alpine — this image compiles things
(node-gyp, cargo, cgo, `psycopg`, PECL), and glibc plus Debian's `-dev` packages
are what those expect.

| | version | how it's pinned |
|---|---|---|
| Node | 24 (Active LTS) | major pinned; the exact build is resolved from `nodejs.org/dist/latest-v24.x` and verified against its `SHASUMS256.txt` |
| npm | bundled with Node | — |
| pnpm | 11.18.0 | exact, via `npm i -g` |
| yarn | 1.22.22 (classic) | exact, via `npm i -g` |
| PHP | 8.4 | whatever `trixie` ships — the base image tag **is** the pin |
| Composer | 2.x | major pinned; installer verified against `composer.github.io/installer.sig` |
| Python | 3.13 | ships with `trixie` |
| uv / uvx | 0.12.1 | exact, verified against the release's `.sha256` |
| pipx | from apt | — |
| Go | 1.26.5 | exact, sha256 from `go.dev/dl/?mode=json` |
| Rust | 1.97.1 + `rustfmt`, `clippy` | exact toolchain; `rustup-init` verified against its `.sha256` |

Plus: `git`, `git-lfs`, `build-essential`, `pkg-config`, `curl`, `jq`, `rsync`,
`openssh-client`, `sqlite3`, `sudo`, `unzip`/`zip`, `libssl-dev`, `libpq-dev`,
`default-libmysqlclient-dev`, and the usual PHP extensions (`mbstring`, `xml`,
`curl`, `zip`, `intl`, `gd`, `bcmath`, `sqlite3`, `mysql`, `pgsql`, `redis`).

Every version above is a `--build-arg`. Bumping one is a one-line edit to the
`ARG` block in the Dockerfile; nothing else in the build reads a version.

**Not** installed, on purpose:

* **Corepack shims.** `corepack enable` makes `pnpm` a shim that resolves the
  version from a repo's `packageManager` field and **downloads it on first use** —
  which turns "run the dev server" into a network call that can fail. A real
  global pnpm works offline. A repo that genuinely needs an exact pnpm runs
  `sudo corepack enable` itself (`COREPACK_ENABLE_DOWNLOAD_PROMPT=0` is already
  set so it won't sit at a prompt).
* **Databases.** Postgres, MySQL and Redis are *services*, and services are P3 —
  separate containers on the workspace's own network, not processes crammed into
  the dev container. The client libraries are here so drivers build; the servers
  are not.

Expect roughly **3–4 GB** compressed-to-disk. That is the cost of the decision;
`images.ts` argues why it is the right one.

---

## uid / gid matching

**The problem.** On Linux a bind mount carries no ownership translation. A
container process writing to `/workspace` writes with *its* numeric uid, so if
that is not the host user's uid, `npm install` inside the sandbox produces a
`node_modules` the user cannot delete. On Docker Desktop for macOS and Windows
the VM translates ownership and none of this applies.

**The default.** The image builds a non-root user `genie` at **1000:1000** — the
first human user on essentially every Linux desktop. The common case therefore
needs no adjustment at all, and nothing here runs as root.

**When the host isn't 1000.** Pass two env vars to the container:

```
HOST_UID=1001
HOST_GID=1001     # defaults to HOST_UID when unset
```

`genie-entrypoint` (PID 1) sees the mismatch and calls `genie-align-uid` through
one NOPASSWD sudo rule, which `usermod`s `genie` to those numbers and re-owns
`/home/genie`. It **does not** touch `/workspace` — those files already carry the
host's ownership, which is exactly what was just matched to; recursively chowning
someone's repo would be slow and destructive.

**Why this works for the processes that matter.** `docker exec` / `podman exec`
resolve the image's `USER genie` against the **container's** `/etc/passwd` at exec
time — and the entrypoint has already rewritten that file in the container's own
layer. So every dev server P2 starts with an `exec` lands on the aligned uid
automatically, with a real passwd entry, a real `$HOME` and a real shell. (A bare
`--user 1001:1001` would give you the right numbers and none of those things,
and `ContainerSpec` in `container-runtime.ts` has no `user` field anyway — but it
does have `env`, so this needs no P1 change to wire up.)

PID 1 itself keeps the uid it started with; renumbering a running process is not
something Linux offers. It costs nothing — PID 1 here is `tail -f /dev/null`,
which touches no files.

Malformed input is a **warning on stderr**, not a failed start: `HOST_UID=abc` or
`HOST_UID=0` logs why it was ignored and the container comes up as `genie`
anyway. A sandbox that refuses to start over an env var is worse than one that
starts and says what it did.

> **Podman, rootless: not covered by this.** Rootless Podman maps container uids
> through the user's *subuid* range, so container-1000 is not host-1000 and
> `HOST_UID` alignment does not produce host-owned files. The fix there is
> `--userns=keep-id`, which is a `ContainerSpec` field P2 has to add — not
> something this image can do from the inside. Rootful Podman behaves like
> Docker and works as described above.

---

## Publishing

**Never automatic.** The workflow is `.github/workflows/dev-base-image.yml` and
it has exactly two triggers:

| trigger | what happens |
|---|---|
| push a `dev-base-v*` tag | builds **and publishes** |
| `workflow_dispatch` | builds and smoke-tests only, unless `publish` is ticked |

There is deliberately no build on branch push or pull request: this is a
multi-gigabyte image that contains none of Genie's own code and changes maybe
twice a year.

To publish:

```sh
git tag dev-base-v1.0.0
git push origin dev-base-v1.0.0
```

That pushes two tags — the exact version `:1.0.0` (immutable) and the major `:1`
(moving). Both architectures are built on **native runners** (`ubuntu-latest` and
`ubuntu-24.04-arm`), pushed by digest, and stitched into one manifest list only
after both succeed. QEMU emulation is avoided on purpose: this image runs
compilers during its build, which is the workload QEMU makes 10–20× slower.

Both legs run the image before anything is pushed — every toolchain on the
`genie` user's PATH, in a login shell as well as a plain one, and a live
`HOST_UID`/`HOST_GID` alignment asserted through a real `docker exec`. A green
`docker build` proves the layers assembled; it proves nothing about the last
three lines of the Dockerfile, which are the ones that decide who the container
is.

### Package visibility is an owner setting

The repo is public; the licence is proprietary. A **new** GHCR package is created
**private** and a workflow cannot change that. After the first publish, someone
with owner rights sets it at
`github.com/orgs/Renaissance-Analytics/packages` → `genie-dev-base` →
*Package settings*. Until it is public, a desktop `docker pull` needs a GHCR
login — which is why the desktop's `image-missing` failure hands the user the
exact `docker pull` to run rather than pulling silently.

---

## Bumping

1. Edit the `ARG` you care about in `Dockerfile`.
2. Decide which number moves:
   * **Same major** (`dev-base-v1.1.0`) for anything a running workspace can
     absorb: security rebuilds, patch bumps, an added apt package. `:1` moves,
     and every workspace picks it up on its next pull. **Nothing in the repo
     changes.**
   * **New major** (`dev-base-v2.0.0`) for anything that could break a
     workspace's build — a new Node/PHP/Python major, a Debian base bump. `:1`
     stays where it is; `:2` is new, and **`GENIE_DEV_BASE_IMAGE` in
     `main/dev-server/images.ts` is the single line that has to change** to
     adopt it. That constant is the only consumer of this image anywhere in the
     codebase.
3. Tag and push. There is no step 4 — the workflow does the rest.

Never `:latest`. A workspace's toolchain must not change under it on a restart.

---

## Running it by hand

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  ghcr.io/renaissance-analytics/genie-dev-base:1 bash
```

`genie` has passwordless `sudo` — a dev container you cannot install a package
into is not a dev container. The apt lists are cleaned out of the image, so an
install is two commands: `sudo apt-get update && sudo apt-get install …`.

Building it locally (slow — one architecture, no cache):

```sh
docker build -t genie-dev-base:local main/dev-server/dev-base
```

The Dockerfile needs BuildKit for `COPY --chmod`, which is the default in any
current Docker.

### If a build fails

* **`toomanyrequests` on `FROM debian:trixie-slim`** — Docker Hub's anonymous
  pull limit, shared across GitHub's runner IPs. Re-run; it is not a code
  problem.
* **`exec /usr/local/bin/genie-entrypoint: no such file or directory`** on an
  image that plainly contains that file — CRLF line endings in the build
  context, so the kernel read the shebang as `/bin/sh\r`. The `.gitattributes`
  in this directory exists to prevent exactly that on Windows checkouts; if you
  copied the scripts in by hand, check them.
* **A checksum mismatch** — an upstream re-cut a release, or a download was
  truncated. Both are worth looking at rather than working around; the whole
  point of the checks is that `:1` is reproducible.
