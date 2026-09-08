# syntax=docker/dockerfile:1
#
# genie-postgres — the Postgres engine image the Genie dev server runs.
#
# ## Why this image exists
#
# `main/dev-server/services/extensions.ts` decides which Postgres extensions a
# workspace may ask for. The IMAGE decides which ones exist. Those two had never
# been connected, and no stock image could connect them:
#
#   * `pgvector/pgvector:pgN` ships `vector` and the contrib set, and no PostGIS.
#   * `postgis/postgis:N-3.x` ships PostGIS, and no pgvector.
#
# So a workspace that wants both — a perfectly ordinary thing to want — had no
# stock image at all, and `postgis` was whitelisted, advertised in
# `manageService`'s own tool description, and answered `could not open extension
# control file`. This image is the answer: ONE Postgres carrying every extension
# the whitelist names.
#
# ## Why the base is pgvector and not postgis
#
# `pgvector/pgvector:pgN` is what Genie ran before this image existed, so basing
# on it changes exactly ONE thing. Everything the catalog depends on — the
# PGDATA layout, `POSTGRES_PASSWORD`/`POSTGRES_DB` bootstrap, the official
# entrypoint, `psql`/`pg_isready` on PATH, the contrib extensions, and `vector`
# itself — is inherited unchanged rather than re-established and re-verified.
# That is what makes this a drop-in for `service-manager.ts` and `provision.ts`.
#
# Going the other way (postgis base + build pgvector) would compile pgvector
# from source on every build, swap the base out from under the extension that
# already worked, and inherit the postgis image's initdb hook, which installs
# PostGIS into `template1` so that EVERY new database gets it whether or not the
# workspace asked. Genie installs extensions per workspace database, deliberately
# (`provision.ts`), so an image with an opinion about template1 is the wrong
# starting point.
#
# `pgvector/pgvector:pgN` is itself `FROM postgres:$PG_MAJOR`, which means the
# PGDG apt repository and its signing key are ALREADY configured in the base.
# PostGIS is therefore one `apt-get install` with no third-party repo to add and
# no key to rotate — it comes from the same publisher Postgres itself does.
#
# ## Reproducibility, honestly stated
#
# PGDG is a ROLLING repository, so — unlike `dev-base/Dockerfile`, where the
# `debian:trixie-slim` tag pins apt — the base tag does NOT pin the PostGIS
# version here. Two builds of this file a year apart can produce different
# PostGIS point releases. That is why the published tags come in pairs: the
# IMMUTABLE `:pgN-<version>` is the reproducibility unit, and `POSTGIS_VERSION`
# below is the handle for pinning or bisecting an exact one. The alternative —
# hard-pinning a `3.x.y+dfsg-…pgdg…` string in the repository — breaks the build
# the day PGDG rotates that version out, with no commit of ours involved.
#
# Built and published ONLY by `.github/workflows/postgres-image.yml`, on a
# `postgres-image-v*` tag. Never on a branch push — see `README.md`.

# The Postgres major. Every version in `POSTGRES.versions` (catalog.ts) is built
# from this one file; the workflow's matrix is the list.
ARG PG_MAJOR=17
FROM pgvector/pgvector:pg${PG_MAJOR}

# Fail a pipeline on the FIRST command that fails, not just the last.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

LABEL org.opencontainers.image.source="https://github.com/Renaissance-Analytics/genie" \
      org.opencontainers.image.title="genie-postgres" \
      org.opencontainers.image.description="PostgreSQL for the Genie dev server: pgvector AND PostGIS in one image, plus the contrib set." \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"

# The PostGIS MAJOR, which is part of the package NAME rather than a version
# constraint — `postgresql-17-postgis-3`. Bumping it to `4` when that exists is
# a new image major, not a patch: PostGIS majors are not drop-in for an existing
# cluster.
ARG POSTGIS_MAJOR=3
# Empty = whatever PGDG currently offers, which is the normal case (see
# "Reproducibility" above). Set it to an exact apt version to pin or bisect:
#   --build-arg POSTGIS_VERSION=3.6.4+dfsg-2.pgdg12+1
ARG POSTGIS_VERSION=

# ARG, not ENV: `noninteractive` is right for a build and wrong for the image.
ARG DEBIAN_FRONTEND=noninteractive

# `$PG_MAJOR` is read from the BASE IMAGE's own ENV rather than re-declared as a
# build arg. The base is the authority on which Postgres it contains, so the
# package name can never disagree with the server it is being installed for —
# which a re-declared ARG could, if the FROM tag and the arg were passed apart.
#
# `-scripts` carries the SQL upgrade scripts and `postgis_restore`; a PostGIS
# without them cannot be pg_upgrade'd or restored across versions, which for a
# dev engine that gets recreated is not a theoretical need.
#
# Unpinned apt versions are deliberate; see the header. The two `test`s are the
# check that matters: they start nothing, but a missing control file would mean
# the install silently landed for a different major, and that is precisely the
# failure this image exists to end.
# hadolint ignore=DL3008
RUN set -eux; \
    if [ -n "${POSTGIS_VERSION}" ]; then pin="=${POSTGIS_VERSION}"; else pin=""; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "postgresql-${PG_MAJOR}-postgis-${POSTGIS_MAJOR}${pin}" \
        "postgresql-${PG_MAJOR}-postgis-${POSTGIS_MAJOR}-scripts${pin}" \
    ; \
    rm -rf /var/lib/apt/lists/*; \
    test -f "/usr/share/postgresql/${PG_MAJOR}/extension/postgis.control"; \
    test -f "/usr/share/postgresql/${PG_MAJOR}/extension/vector.control"

# Nothing else changes: ENTRYPOINT, CMD, USER, PGDATA handling, EXPOSE and the
# `docker-entrypoint-initdb.d` contract are all the base image's, unmodified.
# That is the point of the base choice, and `postgres-image.real.test.ts`
# asserts it rather than trusting it.
