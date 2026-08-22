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

- **node-pty's ConPTY files (Windows).** `pretest:e2e` also puts them back when
  something has rebuilt node-pty. On Windows, ConPTY needs `conpty.dll` +
  `OpenConsole.exe` in a `conpty/` folder beside the binding, and those are
  COPIED by node-pty's own `postinstall` rather than compiled. A rebuild through
  `electron-builder install-app-deps` calls node-gyp directly and runs no
  lifecycle scripts, so it leaves a fresh `build/Release/pty.node` with no
  `conpty/` next to it — and node-pty prefers `build/Release` over its shipped
  `prebuilds/`, so every spawn then throws `Cannot find conpty.dll`. Nothing
  notices until something opens a terminal, which is how the Windows leg reached
  the master-window spec with panels, xterms and no ptys at all.

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

### The Hosting Manager harness (`GENIE_E2E_HOSTING=1`)

`main/e2e/hosting.ts` does for the container Dev Server what the mock above does
for GitHub, and is scoped to its OWN flag — `launchGenieE2E('hosting')` sets it,
nothing else does, so no other spec ever runs against a faked hosting backend.

It overrides the six `dev:*` channels (`dev:workstation`, `dev:runtime-status`,
`dev:site`, `dev:service`, `dev:repos`, `dev:engine`) with an in-memory fixture
shaped exactly like what `workstationDevServerInfo` / `runManageSite` /
`runManageService` return. That is what makes the hosting spec deterministic on
CI runners with **no container runtime** (the macOS one cannot have one): both
"Docker is running" and "Docker is installed but stopped" are fixture values.
The components, the pure judgements and the `dev-server:changed` push are all
real; only the containers are not — the container function itself is proven
separately against a live runtime.

The spec scripts it through `globalThis.__GENIE_E2E_HOSTING__`
(`readHostingState` / `resetHosting` / `hostingRuntimeUnavailable` in
`helpers/launch.ts`): read the call log, reset between tests, and take the
runtime away mid-session with a REAL broadcast so the page has to repaint from
the push rather than from a reload.

### The master window is not a harness page (`GENIE_E2E_PAGE=master`)

`showE2EWindow` loads `${page}.html`, so allowing `master` in its route list
points the window at **`renderer/pages/master.tsx` itself** — the app's real main
window, not a mount of one of its components. That is the whole value of the
gate: the harness *is* the product page.

One thing stands in for production, because it has to. `master.tsx` returns early
to `SignInPrompt` when the auth check comes back signed-out, and the E2E profile
is a throwaway with no session, so the window would otherwise open on the sign-in
screen with every assertion out of reach. `main/e2e/mock.ts` therefore answers
**one channel** — `auth:whoami` — with a connected backend, and only when
`GENIE_E2E_PAGE=master` (`isE2EMaster()`, derived from the page rather than a
flag of its own, so no other spec can run against a faked identity). Everything
else is real: the workspaces and terminals come from `main/e2e/master.ts` as
database rows, and the rail, the floor, the panels and the ptys are the shipped
code acting on them.

`main/e2e/master.ts` is idempotent AND resetting, like the agent-access fixture —
plus one thing that one does not need. The master page persists each window's
panel layout in `view_state_json`, and that store WINS on launch: a run that hid
a panel would hand the next run an empty floor while every seeded row sits in the
database. The seed drops its own workspaces' entries (`pruneFixtureViews`, unit
tested) and pins `active_workspace`, so the window always opens on the fixture.

## Tests

- `master-window.spec.ts` — the master window itself (genie#228): it comes up
  signed in on the two-column frame, the rail lists both seeded workspaces with
  the launch target active, the floor lays out the seeded terminal and the status
  bar counts it. The last test is the genie#229 regression gate: switch
  workspaces and the panel that was hidden must NOT be refitted. Off-workspace
  panels stay mounted-hidden to keep their ptys alive, a hidden element measures
  0×0, and fitting there pushed a nonsense geometry to the pty — which a TUI
  answers by reflowing its scrollback to a width the window never had. The
  assertion is on the grid main last APPLIED to the pty
  (`main/terminal/size-tracker`), because by the time the panel is back on screen
  the DOM looks perfectly fine and only the pty remembers.
- `hosting-manager.spec.ts` — the Hosting Manager, both surfaces: the
  workstation settings page (runtime probes, dev-base toolchain, the grouped
  shared-engine inventory) and the per-workspace Hosting panel
  (`WorkspaceSiteManager`). The assertions are the ones only a running UI can
  make — an engine-group tab switch SWAPPING the list, a shared-engine stop
  waiting for its confirmation (asserted on the main-side call log, since a
  dialog that fires anyway looks identical on screen), the page repainting from
  the `dev-server:changed` push when the runtime goes away, the add-a-site
  picker moving the port with the chosen option, and the panel's reframed copy
  (production parity, never "dev server").
- `issuewatch-reconnect.spec.ts` — the device-flow reconnect regression:
  dead-session banner + precise 401 line render → click Reconnect → the device
  user code **stays visible across ≥2 `github:status` polls** while the flow is
  `pending` (the old code cleared it on the first poll because it keyed off
  `connected`) → flip the mock to `flow.kind:'success'` → banner clears + feed
  recovers. Reverting the fix in `IssueWatchFlyout.tsx` (back to
  `if (st.connected …)`) makes this test fail; the fix makes it pass.
