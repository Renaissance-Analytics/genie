# Contributing

Thanks for showing up. Genie is a small Electron + Next.js codebase;
the contribution loop is the standard one.

## Dev loop

```bash
git clone https://github.com/renaissance-analytics/genie.git
cd genie
npm install
npm run dev        # nextron launches Electron + Next.js dev server
```

Other scripts you'll want:

```bash
npm run typecheck:main      # tsc --noEmit on main/
npm run typecheck:renderer  # tsc --noEmit on renderer/
npm run test                # vitest (main-process tests)
npm run test:watch
```

Genie talks to **Tynn** over HTTP. By default it points at
`https://tynn.ai`. For local Tynn development, set `Tynn host` in
Settings to `https://tynn.test` (or wherever your Herd / Valet / Sail
instance lives).

## Code style

- TypeScript everywhere. `strict` in both `tsconfig`s.
- React 19 + Next.js 15 for the renderer.
- No CSS-in-JS. Tailwind utility classes for renderer layout, plain
  CSS files (`styles/master.css`, `styles/globals.css`) for chrome.
- IPC channels follow `domain:verb` (e.g. `terminal:create`,
  `agi:convert`). The preload bridge in `main/preload.ts` is the only
  surface the renderer touches — never expose Node APIs to the
  renderer directly.
- New IPC channel? Update three places: `main/ipc.ts` (or a domain
  IPC file), `main/preload.ts`, `renderer/lib/genie.ts`.

## What's easy to land

Issues labelled **good first issue** are scoped to ~half a day.
Anything in these buckets generally is:

- Shell detection improvements (Windows: PowerShell 7 vs 5, Git Bash;
  POSIX: zsh-vs-bash heuristics).
- TUI app bug reports + repros (`claude code` glitches, `vim` keymap
  weirdness, etc.).
- Layout mode additions to TerminalGrid.
- Accessibility audits on the master view (focus traps, screen reader
  labels).
- Doc fixes — README, agi-format.md, inline comments.

## What's harder to land (talk first)

Open an issue to align before opening a PR for:

- Anything that changes the on-disk format of `.agi` envelopes or
  `project.json`. The format is shared with the AGI gateway; we have
  to coordinate.
- Schema migrations in `main/db.ts`. The migration runner is
  append-only by design — fragile to get right.
- Changes to the multi-attach pty manager. The invariants there are
  subtle (refcounting owners across windows, scrollback bounding,
  detach-vs-kill semantics).
- Anything that touches token storage / Device Flow / `safeStorage`.
  Security-sensitive surface; we want eyes on the diff.

## Tests

Vitest runs in Node and covers main-process pure logic + filesystem
integration:

- `main/workspace/__tests__/project-json.test.ts` — round-trip + preserve-unknown
- `main/workspace/__tests__/create-agi.test.ts` — envelope scaffold + convert
- `main/terminal/__tests__/manager.test.ts` — shell detection helpers

Renderer / Electron E2E tests are not set up yet. If you add one,
Playwright with `_electron` API is the path of least surprise.

## Pull requests

Open against `main`. Squash on merge. Conventional commit prefixes
optional but appreciated (`feat:`, `fix:`, `docs:`, `chore:`).

For any feature visible in the UI: screenshots or a short
screen-recording in the PR description go a long way.

## Code of conduct

Be decent. We're a small project and we want to keep it that way.
