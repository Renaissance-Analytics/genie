# Genie E2E (Playwright + Electron)

End-to-end tests that boot the **real compiled Electron app** and drive the
renderer, to catch interaction / state bugs that unit tests (vitest) and
typecheck cannot — e.g. the device-flow reconnect regression where the GitHub
user code vanished before it could be entered.

**Run E2E before shipping.** Vitest + typecheck never exercise the running UI;
this suite does.

## Run it

```bash
npm run test:e2e
```

That runs `build:e2e` (a `nextron build --no-pack`: builds the renderer static
export + compiles the main bundle into `app/`, **without** electron-builder
packaging) and then `playwright test`. No dev server is needed — the app loads
the exported renderer from `app/*.html` over `file://`.

To skip the rebuild when `app/` is already current:

```bash
npx playwright test
```

### One-time / environment prerequisites

- `npx playwright install` is **not** required — these tests launch Electron
  (already a dependency), not a browser download.
- **Native module ABI.** The Electron main process loads `better-sqlite3`, a
  native module. It must be built for **Electron's** ABI, not plain Node's:

  ```bash
  npx electron-rebuild -f -o better-sqlite3
  ```

  (`-o` rebuilds only that module, skipping `node-pty`, whose Windows build
  needs a toolchain that isn't always present.) After running E2E, restore the
  Node ABI for vitest with `npm rebuild better-sqlite3` (the `pretest` script
  does this automatically before `npm test`).

## The launch invocation

`e2e/helpers/launch.ts`:

```ts
electron.launch({
  args: ['<repo>/app/background.js'],   // the built main entry (package.json "main")
  env: { ...process.env, NODE_ENV: 'production', GENIE_E2E: '1' },
})
```

- `NODE_ENV=production` → main loads the renderer from the static export
  (`app/*.html`) instead of `http://localhost:8888`, so no dev server runs.
- `GENIE_E2E=1` → (a) the GitHub + Issue Watch IPC is replaced by a scriptable
  mock and (b) a dedicated harness window opens.

## How the GENIE_E2E mock works

`main/e2e/mock.ts` is **inert unless `process.env.GENIE_E2E === '1'`** — in a
normal run it is never called and changes no behaviour (`npx vitest run` stays
green, both typechecks stay clean).

When E2E is on, `background.ts`:

1. registers all the real IPC handlers as usual, then
2. calls `registerE2EMocks()`, which for each channel it owns does
   `ipcMain.removeHandler(channel)` then re-`handle()`s it — so the mock
   **overrides** production regardless of registration order, and
3. opens the `e2e-issuewatch` harness window (`renderer/pages/e2e-issuewatch.tsx`),
   which mounts the **real** `IssueWatchFlyout` open against the mocked IPC.

The mock owns exactly the channels the flyout + `useGithubCapabilities` touch:
`github:status`, `github:device:start` / `:cancel`, `github:recheck-capabilities`,
`github:capabilities`, `github:can-access`, `issue-watch:status` / `:repos` /
`:feed` / `:mark-seen` / `:counts` / `:set`, and `tynn:open-in-browser` (recorded
but inert — never launches a real browser).

A test scripts the mock from the **main** process via Playwright's
`electronApp.evaluate(...)`, reaching the live state through the
`globalThis.__GENIE_E2E__` handle (see `scriptMock` / `readMockState` in
`helpers/launch.ts`). The default state models the bug's starting point: a
stored-but-dead session (`connected: true` + `needsReauth` + a 401 read).

The window is opened EARLY in `app.whenReady()` — right after the mocks register —
so it doesn't depend on the later native-module-touching startup (terminal
backend, MCP/control servers) completing. The flyout only needs IPC + the
renderer, both ready at that point.

## Tests

- `issuewatch-reconnect.spec.ts` — the device-flow reconnect regression:
  dead-session banner + precise 401 line render → click Reconnect → the device
  user code **stays visible across ≥2 `github:status` polls** while the flow is
  `pending` (the old code cleared it on the first poll because it keyed off
  `connected`) → flip the mock to `flow.kind:'success'` → banner clears + feed
  recovers. Reverting the fix in `IssueWatchFlyout.tsx` (back to
  `if (st.connected …)`) makes this test fail; the fix makes it pass.
