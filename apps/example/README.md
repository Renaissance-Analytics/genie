# Genie App Example

A working Genie App, kept small enough to read in one sitting. Install it, open it,
then copy whatever you need.

```
apps/example/
├── genie-app.json      the declaration Genie validates and turns into a consent prompt
├── web/                the front end, served by Genie at https://example.gen
│   ├── index.html
│   └── app.js
└── service/            the app's OWN backend, supervised by Genie
    └── server.mjs
```

## Install it

**Apps → Install from folder**, and pick this directory. Genie will:

1. validate `genie-app.json`,
2. ask you what to allow (hosting and Genie's memory — nothing high-risk),
3. create a workspace, copy the source in, serve `web/` at `example.gen`,
4. start `node server.mjs` beside it.

## What it demonstrates

**Multi-component.** A front end *and* a backend service, in separate processes.
This is the shape real GApps have — the apps this system was designed against pair
a React front end with a Python FastAPI backend — and an example with only a front
end would leave the interesting half undemonstrated.

**Permission-aware UI.** Every control on screen is drawn from
`genieApp.me().capabilities` — what the *user granted* — not from what the manifest
asked for. The pattern to copy is in `web/app.js`: ask, then render.

**Honest refusals.** The app deliberately keeps one button it was *not* granted, so
you can see what a refusal looks like: Genie's own sentence, written for a person,
shown verbatim. Your app should do the same, minus the button.

**No bundler.** Not because you shouldn't use one — because a reference whose first
lesson is "install forty packages" teaches the wrong thing. It uses
`window.genieApp` directly to show you what the runtime surface actually is. Real
apps should use [`@genie/app-sdk`](../../packages/app-sdk/README.md), which is a
thin typed wrapper over exactly these two calls.

## What to change first

- `id`, `slug`, `name` — the slug becomes your address, `<slug>.gen`.
- `permissions.capabilities` — ask for the least that lets your app work. Every
  entry is a line the user reads, and a reason to say no.
- `frontend.serve` — `static` over a built directory, or `proxy` at a dev server's
  port while you are still building.
