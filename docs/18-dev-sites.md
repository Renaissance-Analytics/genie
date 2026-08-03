# Hosting sites at `.gen` (the Hosting Manager)

Genie can **build a repo and run it the way it runs in production**, then serve
it at a stable **`https://<name>.gen`** URL — viewable in Genie's built-in
**Genie Browser**, whether you're on this machine or driving a
**[host](17-hosts-and-workstations.md)** remotely. This is the **Hosting
Manager**. It does *not* proxy an existing dev server (Herd/Valet, `npm run
dev`); it builds the project and serves the built artifact with a real
production server, each site in its own container sandboxed to its workspace.

## What a hosted site is

For each site the Hosting Manager runs the **production build + serve** for the
detected stack, inside the workspace's container:

- **PHP / Laravel** → `composer install --no-dev`, served by **FrankenPHP** over
  `public/`.
- **Next.js** → `npm run build`, then `next start` (Nuxt → the built Nitro
  server).
- **A built front end** (Vite / CRA) → **nginx** over `dist/`, with no
  JavaScript process at all.
- **Django** → a virtualenv + `collectstatic`, served by **gunicorn**;
  **FastAPI / Flask** → **uvicorn**.
- **Go** → `go build` and run the binary; **Rust** → `cargo build --release`
  and run it.

A repo's own **Dockerfile** always wins over a detected recipe. A failed build
is the usual reason a site doesn't come up — the site is deliberately **not**
started on a failed build, and the build log is kept with the site so you can
see why.

## Managing sites — the Site Manager

Each workspace has a **Site Manager** (its server icon in the sidebar, or
right-click the workspace) with two tabs:

- **Sites** — what this workspace hosts. Point it at a repo and it detects the
  build + production server + port; you can also set them explicitly. Each site
  shows both origins (the routable `<name>.gen` and a direct loopback origin for
  `curl`), a `running`/`ready` status, start / stop / restart, the build + server
  log, and **Open in the Genie Browser**.
- **Services** — the backing engines those sites connect to: **Postgres, MySQL,
  Redis, Meilisearch, MinIO (S3), Mailpit**, or a custom image. Each engine is
  **shared** across the workstation per *(engine, major version)* — one
  `postgres:16` backs every workspace that asks for Postgres 16 — and each
  workspace gets its own database, role and credentials on it. The connection
  env (`DATABASE_URL`, …) is injected into the workspace's sites automatically,
  at runtime and during their build.

Agents manage exactly the same thing over MCP via the `manageSite` and
`manageService` tools — the panel and the tools drive one shared implementation,
so neither can drift from the other. See
**[Agents & the Genie MCP](12-agents-and-mcp.md)**.

Machine-wide pieces — the container runtime, the base image, and the shared
service engines' start/stop — live in **[Settings → Hosting
Manager](08-settings.md)**, because they belong to the computer, not to any one
workspace. The Hosting Manager needs **Docker or Podman**; until one is present
Genie shows the install hint instead of controls that can't work.

## What is (and isn't) reachable

Inside a hosted container, `localhost` **is** the workspace, so the app reaches
its own processes and its services normally. **Backends are never exposed** — a
database or cache has no `.gen` name; it's reached over the workspace network
through the injected env. Only **browser-facing** surfaces are published: the
site at `<name>.gen`, plus any extra surface you deliberately add with a reason
the browser needs it. Every server binds `0.0.0.0` inside the container.

## The Genie Browser

`.gen` sites open in Genie's built-in **Genie Browser** — a real browser with
full chrome, not just an iframe:

- **Back / forward / reload** buttons and a **URL bar** (with a lock icon for the
  HTTPS connection).
- A **tab strip** — open several `.gen` sites at once, each in its own tab.
- **Device presets** to preview at different viewport sizes.
- **Quick-nav** buttons for the hosted `.gen` sites.

Each session terminates HTTPS with its own generated CA, so `.gen` names resolve
only inside that browser — nothing is exposed to the wider network. The Genie
Browser is on by default and can be toggled in
**[Settings → Hosting Manager](08-settings.md)**; turning it off means a `.gen`
site opens nowhere.
