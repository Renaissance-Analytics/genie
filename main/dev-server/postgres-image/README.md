# genie-postgres

The Postgres every Genie workspace's database runs on.

```
ghcr.io/renaissance-analytics/genie-postgres:pg17-1
```

One image tag per Postgres major (**pg14, pg15, pg16, pg17** — the versions
`POSTGRES.versions` in `main/dev-server/services/catalog.ts` offers).

---

## Why Genie publishes a Postgres

`main/dev-server/services/extensions.ts` whitelists the extensions a workspace
may ask for, and `manageService`'s tool description advertises them. Two of
those names could not both be true at once:

| image | `vector` | `postgis` |
|---|---|---|
| `pgvector/pgvector:pgN` | yes | **no** |
| `postgis/postgis:N-3.x` | **no** | yes |
| `postgres:N` | no | no |

So a workspace that wanted both had **no stock image at all**, and
`CREATE EXTENSION postgis` answered Postgres's own *"could not open extension
control file"* — a capability promised in three places and delivered in none.
This image carries every name on that whitelist.

## What's in it

Base: **`pgvector/pgvector:pgN`**, which is itself `FROM postgres:$PG_MAJOR` on
Debian bookworm.

| | where it comes from |
|---|---|
| PostgreSQL | the base image — the `pgN` tag **is** the pin |
| `vector` (pgvector) | the base image |
| PostGIS 3 + `-scripts` | PGDG apt, `postgresql-$PG_MAJOR-postgis-3` |
| `uuid-ossp`, `pg_trgm`, `citext`, `hstore`, `pgcrypto`, `unaccent`, `btree_gin`, `btree_gist` | `postgresql-contrib`, in the base |

Nothing else changes: `ENTRYPOINT`, `CMD`, `USER`, `EXPOSE`, the PGDATA handling
and the `docker-entrypoint-initdb.d` contract are all the base image's,
unmodified.

### Why the base is pgvector and not postgis

Basing on what Genie already ran changes exactly **one** thing. The PGDATA
layout, the `POSTGRES_PASSWORD` / `POSTGRES_DB` bootstrap, the official
entrypoint, `psql` / `pg_isready` on PATH, the contrib set and `vector` itself
are inherited unchanged rather than re-established and re-verified — which is
what makes this a drop-in for `service-manager.ts` and `provision.ts`.

Going the other way (postgis base, build pgvector) would compile pgvector on
every build, swap the base out from under the extension that already worked, and
inherit the postgis image's initdb hook — which installs PostGIS into `template1`
so **every** new database gets it, asked for or not. Genie installs extensions
per workspace database deliberately (`provision.ts`), so an image with an opinion
about `template1` is the wrong starting point.

The base also already has the PGDG apt repository and its signing key configured,
so PostGIS is one `apt-get install` with no third-party repo to add and no key to
rotate: it comes from the same publisher Postgres itself does.

### Reproducibility, honestly

PGDG is a **rolling** repository. Unlike `dev-base/`, where the
`debian:trixie-slim` tag pins apt, the base tag here does **not** pin the PostGIS
version — two builds a year apart can produce different point releases. That is
why every publish emits a pair of tags, and why the immutable one is the
reproducibility unit. `POSTGIS_VERSION` is the build-arg handle for pinning or
bisecting an exact one:

```sh
docker build --build-arg PG_MAJOR=16 \
             --build-arg POSTGIS_VERSION=3.6.4+dfsg-2.pgdg12+1 \
             -t genie-postgres:local main/dev-server/postgres-image
```

Hard-pinning that string in the repository instead would break the build the day
PGDG rotates the version out, with no commit of ours involved.

---

## The tag

```
pg<postgres major>-<image major>
```

Two majors, because two things move independently:

* the **Postgres major** is the user's choice and part of the engine KEY
  (`postgres-17`) — `pg15` and `pg17` are not interchangeable and a workspace
  pinned to one must never be silently migrated to the other;
* the **image major** is Genie's own. A security rebuild or an added extension
  republishes `pg17-1` and reaches every workspace on its next pull. A breaking
  change — a PostGIS major, a base change — becomes `pg17-2` and leaves running
  workspaces alone.

Never `:latest`. A workspace's engine must not change under it on a restart.

`GENIE_POSTGRES_IMAGE_MAJOR` in `catalog.ts` is the single line that adopts a new
image major.

---

## Publishing

**Never automatic.** The workflow is `.github/workflows/postgres-image.yml`:

| trigger | what happens |
|---|---|
| push a `postgres-image-v*` tag | builds **and publishes** |
| `workflow_dispatch` | builds and smoke-tests only, unless `publish` is ticked |

```sh
git tag postgres-image-v1.0.0
git push origin postgres-image-v1.0.0
```

For each Postgres major that publishes two tags — `:pgN-1.0.0` (immutable) and
`:pgN-1` (moving). Both architectures are built on **native runners**
(`ubuntu-latest`, `ubuntu-24.04-arm`), pushed by digest, and stitched into one
manifest list per major only after both succeed.

Every leg **runs the database before anything is pushed**: it starts the image
with the exact env `catalog.ts` starts an engine with, asserts the server is the
major that was asked for, asserts PGDATA landed in the subdirectory, installs
every whitelisted extension, and calls into PostGIS and pgvector so an extension
whose control file shipped without its library cannot pass.

### Package visibility is an owner setting

The repo is public; the licence is proprietary. A **new** GHCR package is created
**private** and a workflow cannot change that. After the first publish, someone
with owner rights sets it at `github.com/orgs/Renaissance-Analytics/packages` →
`genie-postgres` → *Package settings*. Until it is public, a desktop `docker
pull` needs a GHCR login — which is why `service-manager.ts` hands the user the
exact `docker pull` command rather than pulling silently.

---

## Adopting it on a machine that already ran Postgres

An engine container is adopted by NAME, not by image, so a `postgres-17` that
Genie started before this image existed keeps running the old one until somebody
says otherwise. **Settings → Dev Server → Recreate** is that somebody: it replaces
the container on the pinned image and keeps the named volume, so the data and
every workspace's database survive.

Recreation is never automatic, and it is the **workstation operator's** action,
not an agent's — it restarts an engine every other workspace on it is holding,
which is not a decision one workspace makes for the rest. An agent reading
`manageService inventory` is told the same fact (`staleImage`, `runningImage`) so
it can SAY why an advertised extension will not install, rather than work around
it or report a bug in the feature.

> **A stale volume can misbehave.** The engine Genie ran before pgvector was
> `-alpine` (musl); this image, like pgvector's, is Debian (glibc). Re-opening an
> alpine-era data volume under it can hit text-index collation differences. Dev
> data is regenerable — `remove` with `purge` and start again if one does.

---

## Testing it

* **Per commit** — `main/dev-server/services/__tests__/postgres-image.real.test.ts`
  builds this Dockerfile and installs every whitelisted extension into a real
  engine. Runs in CI's `hosting` job (`npm run test:hosting`), and locally
  wherever there is a Docker daemon. It builds ONE major; the workflow covers
  all four.
* **Per commit, in seconds** — `main/dev-server/__tests__/postgres-image.test.ts`
  is the drift guard: the whitelist, this Dockerfile, the catalog's versions and
  the workflow's matrix all have to agree, so adding an extension without an
  image that carries it fails before anything is published.

Building it by hand:

```sh
docker build --build-arg PG_MAJOR=17 -t genie-postgres:local main/dev-server/postgres-image
```
