import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    hostingRuntimeUnavailable,
    launchGenieE2E,
    readHostingSites,
    readHostingState,
    resetHosting,
    seedHostingSites,
} from './helpers/launch';

/**
 * E2E for the HOSTING MANAGER (genie #234) — both surfaces, in the running app.
 *
 * ## What this covers that nothing else can
 *
 * The judgements are already unit-tested as pure functions
 * (`renderer/lib/workstation-dev-server.ts`, `renderer/lib/dev-server.ts`) and
 * the container layer is proven against a REAL runtime separately. Neither
 * touches the thing in between: a mounted React tree wired to live IPC. Every
 * assertion below is about that seam —
 *
 *   - the machine's report reaching the page at all (a `dev:workstation` that
 *     resolves into a component that never re-renders looks like "no Docker"),
 *   - a tab switch actually SWAPPING the list rather than stacking three,
 *   - a destructive stop WAITING for its confirmation — asserted on the call
 *     log, because a dialog that fires anyway looks identical on screen,
 *   - the page repainting from the `dev-server:changed` PUSH, not just at mount,
 *   - the add-a-site picker keeping the port in step with the chosen option,
 *   - the panel's reframed copy: production parity, never "dev server".
 *
 * ## Why it is deterministic without Docker
 *
 * The CI runners have no container runtime (the macOS one cannot have one), so
 * waiting on a real container would make this either skipped everywhere or a
 * flake generator. `main/e2e/hosting.ts` — active ONLY under
 * `GENIE_E2E_HOSTING=1`, i.e. only for this spec's launch — answers the six
 * `dev:*` channels from an in-memory fixture shaped exactly like what
 * `workstationDevServerInfo` / `runManageSite` / `runManageService` return. The
 * components, the pure judgements and the push wiring are all REAL; only the
 * containers are not. BOTH runtime states are fixture values, so "Docker is
 * running" and "Docker is installed but stopped" are equally deterministic on a
 * runner that has neither.
 *
 * Each test resets that fixture and reloads the harness, so a test that stops an
 * engine cannot hand the next one a different machine.
 */

let app: ElectronApplication;
let page: Page;

/** The open modal — the per-workspace Hosting panel, or the stop confirmation.
 *  Never both at once, and each test says which one it opened. */
const MODAL = '[data-react-fancy-modal]';
/** The engine rows of whichever machine-level group tab is showing. */
const ENGINES = '.ws-engines';

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('hosting'));
});

test.afterAll(async () => {
    await app?.close();
});

test.beforeEach(async () => {
    await resetHosting(app);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // The section paints 'Checking…' until `dev:workstation` answers; every
    // test starts from the settled read.
    await expect(page.locator('.set-row', { hasText: 'Docker or Podman' })).toContainText(
        'Docker 27.1.1',
    );
});

/** Open the per-workspace Hosting panel and wait for its first read. */
async function openPanel(p: Page) {
    await p.getByTestId('open-hosting-panel').click();
    const modal = p.locator(MODAL);
    await expect(modal).toBeVisible();
    return modal;
}

// --- the workstation page ---------------------------------------------------

test('the workstation page reports what THIS machine can build and serve', async () => {
    // The runtime verdict, and every candidate behind it. "docker: found,
    // engine unreachable" is the line that ends a support thread — a page that
    // prints only the verdict cannot tell "install it" from "start it".
    const probes = page.locator('.ws-probes');
    await expect(probes).toContainText('Docker 27.1.1 — running');
    await expect(probes).toContainText('Podman — not installed');

    // The base image + the toolchain it brings. These are read from a constant
    // mirrored off the image's Dockerfile precisely so rendering this page
    // never pulls gigabytes — so their ABSENCE here is a real regression.
    const devImage = page.locator('.set-row', { hasText: 'genie-dev-base' });
    await expect(devImage).toContainText('ghcr.io/wishborn/genie-dev-base:1');
    await expect(devImage).toContainText('Downloaded');
    const toolchain = page.locator('.ws-toolchain');
    await expect(toolchain).toContainText('Node 22.11.0');
    await expect(toolchain).toContainText('npm 10 · pnpm 9');
    await expect(toolchain).toContainText('PHP 8.3');
    await expect(toolchain).toContainText('Python 3.12');

    // The shared-services inventory, GROUPED. The counts are the assertion: a
    // flat list of a dozen catalog rows buries the one that is running.
    await expect(page.getByRole('tab', { name: 'Running (1)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'On this machine (1)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Available (1)' })).toBeVisible();

    // And WHO is on the running one — the sentence that makes a machine-level
    // stop honest.
    await expect(page.locator(ENGINES)).toContainText(
        'Shared with 3 workspaces: Tynn, Guardian and Hosting E2E.',
    );
});

test('switching engine groups SWAPS the list — the three are not one long page', async () => {
    const engines = page.locator(ENGINES);
    await expect(engines.getByText('Postgres 16', { exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'On this machine (1)' }).click();
    await expect(page.getByRole('tab', { name: 'On this machine (1)' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    // The state assertion: the previous group's row is GONE, not merely scrolled
    // past. A panel that renders all three at once passes every "is the text
    // there" check and ships a broken page.
    await expect(engines.getByText('Postgres 16', { exact: true })).toHaveCount(0);
    await expect(engines.getByText('Redis 7', { exact: true })).toBeVisible();
    // Pulled once, never started — the state nothing else in Genie reports, and
    // usually the answer to "what is taking up my disk".
    await expect(engines).toContainText('Its container exists but is stopped');

    await page.getByRole('tab', { name: 'Available (1)' }).click();
    await expect(engines.getByText('Redis 7', { exact: true })).toHaveCount(0);
    await expect(engines.getByText('MySQL 8', { exact: true })).toBeVisible();
    await expect(engines).toContainText('Not on this machine.');
    // Nothing uses it, so there is nothing to start: a Start that would fail
    // every time is worse than no Start.
    await expect(engines.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);

    // ...but it CAN be pre-downloaded (#242 P3, multi-version). Install is the
    // one action with no consumer requirement — holding another major ready
    // before a workspace asks for it is the entire point.
    const row = engines.locator('.ws-engine', { hasText: 'MySQL 8' });
    await row.getByRole('button', { name: 'Install', exact: true }).click();

    // It reached main as an install for THAT version...
    await expect
        .poll(async () => (await readHostingState(app))?.calls.engine ?? [])
        .toContain('install:mysql-8');

    // ...and the page FOLLOWS the row. The image being here changes the state the
    // tabs group by, so the row leaves "Available" — vanishing from under the
    // click would read as "nothing happened", so the page switches to where it
    // went and SAYS so (entry -> action -> visible confirm -> next).
    await expect(page.getByTestId('engine-done')).toContainText('MySQL 8 is downloaded');
    await expect(page.getByTestId('engine-done')).toContainText('Nothing is running yet');
    await expect(page.getByRole('tab', { name: /^On this machine/ })).toHaveAttribute(
        'aria-selected',
        'true',
    );

    const installed = engines.locator('.ws-engine', { hasText: 'MySQL 8' });
    // Downloaded, NOT started — a pulled image is not a running engine, and the
    // page keeps those two facts separate.
    await expect(installed).toContainText('Downloaded but not running');
    await expect(installed.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
    await expect(installed.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test('stopping a SHARED engine asks first, names who it takes down, and does NOT fire on cancel', async () => {
    const row = page.locator('.ws-engine', { hasText: 'Postgres 16' });
    await row.getByRole('button', { name: 'Stop', exact: true }).click();

    const confirm = page.locator(MODAL);
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('heading', { name: 'Stop Postgres 16?' })).toBeVisible();
    // Not "are you sure" — the count AND the names, because the hazard is
    // stopping "your" database and taking three other projects offline.
    await expect(confirm).toContainText(
        '3 workspaces (Tynn, Guardian and Hosting E2E) are using this engine right now.',
    );
    await expect(confirm).toContainText('Stopping it here stops it for all of them');

    // THE assertion the DOM cannot make: nothing has been stopped yet. A confirm
    // that renders and fires anyway looks exactly like one that waits.
    expect((await readHostingState(app))?.calls.engine).toEqual([]);

    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator(MODAL)).toHaveCount(0);
    expect(
        (await readHostingState(app))?.calls.engine,
        'cancelling a confirmed stop must not stop the engine',
    ).toEqual([]);
    // Still running for everyone.
    await expect(page.getByRole('tab', { name: 'Running (1)' })).toBeVisible();

    // Confirming DOES fire it — and the page re-reads, so the row leaves the
    // running group and joins the installed one. Both halves matter: an action
    // that fires but never repaints is the bug this surface is most likely to
    // grow.
    await row.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.locator(MODAL).getByRole('button', { name: 'Stop it for everyone' }).click();
    await expect(page.getByRole('tab', { name: 'Running (0)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'On this machine (2)' })).toBeVisible();
    expect((await readHostingState(app))?.calls.engine).toEqual(['stop:postgres-16']);
});

test('losing the container runtime repaints the page from the PUSH — guided, not broken', async () => {
    const row = page.locator('.ws-engine', { hasText: 'Postgres 16' });
    await expect(row.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

    // Docker Desktop quits. Main fires the REAL `dev-server:changed` broadcast;
    // NOTHING here reloads the page. If the surface only reads at mount it stays
    // frozen on a machine state that no longer exists — invisible in a
    // screenshot, fatal in use.
    await hostingRuntimeUnavailable(app);

    // INSTALLED-but-stopped, not "no runtime": they need opposite advice, and
    // telling someone to install what they already have is the failure that
    // split exists to prevent.
    await expect(page.locator('.set-row', { hasText: 'Docker or Podman' })).toContainText(
        'A container runtime is installed but not running',
    );
    await expect(page.locator('.ws-probes')).toContainText('installed, engine not running');
    // Guided: the next step is spelled out rather than left as a dead end.
    await expect(
        page.locator('.set-note', { hasText: 'start Docker Desktop' }),
    ).toBeVisible();

    // Actions that cannot work are withdrawn rather than left to fail.
    await expect(row.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Log', exact: true })).toHaveCount(0);
});

// --- the per-workspace Hosting panel ----------------------------------------

test('the workspace Hosting panel leads with HOST-NATIVE hosting (dev server on the host, no per-site container)', async () => {
    const modal = await openPanel(page);

    await expect(modal.getByRole('heading', { name: 'Hosting — Hosting E2E' })).toBeVisible();
    // The model, plainly: each site is the repo's own dev server on the host;
    // Docker is only for the services behind it.
    await expect(modal).toContainText("Each site is your repo's dev server");
    await expect(modal).toContainText('Docker runs the services');

    // The reframe, asserted as an ABSENCE: the panel copy must carry NO container
    // production-build / opt-in language at all — the owner ripped that framing out
    // of the UI (it read as "why is Genie still doing containers").
    const panelText = await modal.innerText();
    expect(
        panelText,
        'the Hosting panel copy must not use production-build / opt-in / container language',
    ).not.toMatch(/production build|opt-in|built and then\s+served the way it runs in production/i);

    // Docker is for the SERVICES behind the sites now, not the sites themselves.
    await expect(modal).toContainText('Sites run on the host');
    await expect(modal).toContainText('Docker 27.1.1 runs the services');

    // Nothing hosted yet — the first thing a real user meets, and it points at
    // the next step rather than showing an empty box.
    await expect(modal).toContainText('Nothing hosted here yet.');
    await expect(modal.getByRole('button', { name: 'Add a site…' })).toBeVisible();
});

test('add-a-site: the DEFAULT runs the repo\'s dev server on the HOST — no recipe, no container', async () => {
    // This is the host-native pivot (story #238) at the seam a human meets it:
    // a plain "Add & start" must run the repo's own dev server on the host, NOT
    // build a container. A create that quietly forced a recipe runMode is the
    // exact "why is Genie still doing containers" regression this guards.
    const modal = await openPanel(page);
    await modal.getByRole('button', { name: 'Add a site…' }).click();

    const name = modal.getByLabel('Name for the new site');
    await expect(name).toBeVisible();
    // Gated until it is named — a site with no name has no address to be
    // reached at.
    await expect(modal.getByRole('button', { name: 'Add & start' })).toBeDisabled();
    await name.fill('web');
    await expect(modal.getByRole('button', { name: 'Add & start' })).toBeEnabled();

    // The advanced (recipe) path is a secondary control, not the default — a plain
    // Add & start never touches it, and it carries no "production build" wording.
    await expect(
        modal.getByRole('button', { name: 'Advanced — pick how it runs' }),
    ).toBeVisible();

    // Add & start WITHOUT touching the recipe picker. THE state assertion: the
    // created site is HOST-NATIVE (`runMode: 'host'`) — the backend's
    // dev-native-first create, not a forced container recipe.
    await modal.getByRole('button', { name: 'Add & start' }).click();
    await expect
        .poll(async () => (await readHostingSites(app)).find((s) => s.name === 'web')?.runMode)
        .toBe('host');
    expect((await readHostingState(app))?.calls.site).toContain('create');
});

test('add-a-site: the advanced run-picker moves the port with the choice, and says what it guessed', async () => {
    const modal = await openPanel(page);
    await modal.getByRole('button', { name: 'Add a site…' }).click();

    const name = modal.getByLabel('Name for the new site');
    const port = modal.getByLabel('The port the dev server listens on');
    await name.fill('web');

    // The recipe/build path is behind the explicit "advanced" control — the default
    // path (Add & start, above) never reaches it. Until this runs there is nothing
    // to choose between.
    await modal.getByRole('button', { name: 'Advanced — pick how it runs' }).click();

    const runAs = modal.locator('label.site-field', { hasText: 'Run it as' }).locator('select');
    await expect(runAs).toBeVisible();
    // Each option NAMES what it runs and WHICH repo file said so — "Node" alone
    // does not let anyone judge whether the guess is right.
    await expect(runAs.locator('option')).toHaveText([
        'Node — Dockerfile',
        'PHP — composer.json',
    ]);
    // The detected option's port is adopted, so the common path needs no typing.
    await expect(port).toHaveValue('8000');
    // A confident option makes no claims it cannot back.
    await expect(modal.getByText('Check this before starting:')).toHaveCount(0);

    // THE state assertion: change the choice and the port must follow it. When
    // it does not, the site publishes the previous option's port, gets a
    // connection refused, and reads as a Genie bug rather than a stale field.
    await runAs.selectOption({ index: 1 });
    await expect(port).toHaveValue('3000');
    await expect(modal).toContainText(
        'A Laravel app — served by FrankenPHP the way it runs in production.',
    );
    // And what was INFERRED is said out loud — an option whose port was
    // defaulted rather than read looks exactly like a working site until it
    // refuses the connection.
    await expect(modal).toContainText(
        'Check this before starting: the port was defaulted rather than read from the repo.',
    );

    // Nothing was created by looking: the flow stays a read until it is
    // committed. `create` is what pulls an image and builds.
    expect((await readHostingState(app))?.calls.site).not.toContain('create');
});

// --- the serve-mode picker (genie #167/#171) --------------------------------

test('add-a-site: the serve-mode picker hands a built folder to GENIE (static/SPA), no dev command', async () => {
    // The owner's screenshot: an agent hand-rolled nginx to serve a built SPA.
    // The picker makes that a first-class choice — pick static, name the folder,
    // and Genie serves it. So the recipe/port controls (a proxied dev server's
    // concern) drop away, and the create carries the SAME `hostServe` an agent sends.
    const modal = await openPanel(page);
    await modal.getByRole('button', { name: 'Add a site…' }).click();
    await modal.getByLabel('Name for the new site').fill('wallet');

    const serveAs = modal
        .locator('label.site-field', { hasText: 'How Genie serves it' })
        .locator('select');
    await serveAs.selectOption('static');

    // A Genie-served site has nothing to detect: the recipe control is gone, and
    // Add & start is GATED until a folder is named (an empty root serves nothing).
    await expect(modal.getByRole('button', { name: 'Advanced — pick how it runs' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Add & start' })).toBeDisabled();
    await modal.getByLabel('Directory Genie serves').fill('dist');
    await expect(modal.getByRole('button', { name: 'Add & start' })).toBeEnabled();

    await modal.getByRole('button', { name: 'Add & start' }).click();

    // THE state assertion: the site is HOST-NATIVE and carries the declared serve
    // mode (SPA on by default) — Genie serves the folder, no server config written.
    await expect
        .poll(async () => (await readHostingSites(app)).find((s) => s.name === 'wallet')?.hostServe)
        .toEqual({ mode: 'static', root: 'dist', spa: true });
    expect((await readHostingSites(app)).find((s) => s.name === 'wallet')?.runMode).toBe('host');
});

test('the site Edit form prefills the serve mode and switches a static site back to proxy', async () => {
    await seedHostingSites(app, [
        {
            id: 'site-wallet',
            name: 'wallet',
            genName: 'wallet.hosting-e2e.gen',
            repo: '',
            runMode: 'host',
            kind: 'http',
            enabled: true,
            state: 'running',
            ready: true,
            hostPort: 49020,
            hostServe: { mode: 'static', root: 'dist', spa: true },
        },
    ]);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    const modal = await openPanel(page);

    await modal.getByRole('button', { name: 'Edit' }).click();
    const edit = page.locator(MODAL);
    await expect(edit.getByRole('heading', { name: 'Edit wallet' })).toBeVisible();

    // Prefilled from the stored config: static, rooted at dist. And because GENIE
    // serves it, there is NO startup-command field (that is a proxied server's).
    const serveAs = edit
        .locator('label.site-field', { hasText: 'How Genie serves it' })
        .locator('select');
    await expect(serveAs).toHaveValue('static');
    await expect(edit.getByLabel('Directory Genie serves')).toHaveValue('dist');
    const editModal = edit.filter({ has: page.getByRole('heading', { name: 'Edit wallet' }) });
    await expect(editModal).not.toContainText('Startup command');

    // Switch back to the repo's own dev server and save.
    await serveAs.selectOption('proxy');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator(MODAL).getByRole('heading', { name: 'Edit wallet' })).toHaveCount(0);

    // THE assertion the DOM only implies: the update CLEARED the serve mode (a plain
    // omit would leave it static — the store merges the patch over the stored row).
    const site = (await readHostingSites(app)).find((s) => s.id === 'site-wallet');
    expect(site?.hostServe, 'switching to proxy must clear the stored serve mode').toBeUndefined();
    expect((await readHostingState(app))?.calls.site).toContain('update');
});

test('the Services view shows what this workspace uses, and what a stop would really do', async () => {
    const modal = await openPanel(page);
    await expect(modal).toContainText('Nothing hosted here yet.');

    await modal.getByRole('tab', { name: 'Services (1)' }).click();

    // The Sites view is gone, not merely below — the same swap assertion as the
    // engine groups, on the panel's own tabs.
    await expect(modal.getByText('Nothing hosted here yet.')).toHaveCount(0);

    await expect(modal).toContainText('Postgres 16');
    await expect(modal).toContainText('Running.');
    // `stop` here is a RELEASE, and the panel has to say so: a user who thinks
    // they stopped a database and finds it still up was misled by the button.
    await expect(modal).toContainText(
        "Shared with 3 workspaces. Stopping only releases THIS workspace's hold",
    );
    // Named honestly rather than flattened to "isolated" — this engine gives a
    // server-enforced database + role; the namespace engines do not.
    await expect(modal).toContainText(
        'This workspace gets its own database and role on the shared engine',
    );
    // BOTH sides of the boundary in one field: the container-network address a
    // sibling container dials, AND the loopback one psql needs. A connection
    // string built from the wrong one fails every time.
    await expect(
        modal.locator('label.site-field', { hasText: 'postgres' }).locator('input'),
    ).toHaveValue(/genie-postgres-16:5432.*127\.0\.0\.1:55432/);
    await expect(modal).toContainText('Injects DATABASE_URL, PGHOST, PGDATABASE');

    // What this workspace does NOT use yet is offered from the same `catalog`
    // call, so the picker needs no second round trip.
    await expect(modal.getByRole('button', { name: 'Redis' })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Mailpit' })).toBeVisible();

    // Closing the panel leaves the workstation page standing behind it. (The
    // panel has no close button of its own — Escape and the backdrop are the
    // only dismissals it offers.)
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('panel-closed')).toBeVisible();
    await expect(page.locator('.set-row', { hasText: 'Docker or Podman' })).toBeVisible();
});

// --- the external-browser toggle (story #238) -------------------------------

test('the site Edit form offers the external-browser toggle for a host-native site, and persists it', async () => {
    // A host-native site (a hostPort, no container) — the ONLY kind the host Caddy
    // fronts, so the only kind the toggle is offered for.
    await seedHostingSites(app, [
        {
            id: 'site-web',
            name: 'web',
            genName: 'web.hosting-e2e.gen',
            repo: '',
            runMode: 'host',
            kind: 'http',
            enabled: true,
            state: 'running',
            ready: true,
            port: 5173,
            hostPort: 49010,
        },
    ]);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    const modal = await openPanel(page);

    await modal.getByRole('button', { name: 'Edit' }).click();
    const edit = page.locator(MODAL);
    await expect(edit.getByRole('heading', { name: 'Edit web' })).toBeVisible();

    // The toggle is offered, OFF by default, and its hint says the first enable is
    // a one-time admin prompt — not a silent privileged side effect.
    const toggleRow = edit.locator('label.site-field', { hasText: 'Open in a real browser' });
    await expect(toggleRow).toBeVisible();
    await expect(toggleRow).toContainText('one-time admin prompt');
    const toggle = toggleRow.getByRole('switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // UX in sync with the host-native model: NO legacy serve field, NO container-only
    // fields (port + image are host-owned/absent), and the startup hint is host-native
    // — never "in the sandbox" or "the port above" (the host allocates the port now).
    // Scope to the Edit modal specifically — the panel behind it is also a modal, so a
    // bare MODAL locator matches two and trips strict mode.
    const editModal = edit.filter({ has: page.getByRole('heading', { name: 'Edit web' }) });
    await expect(editModal).not.toContainText('Serve command (legacy)');
    await expect(editModal).not.toContainText('Port the server listens on');
    await expect(editModal).not.toContainText('Server image');
    await expect(editModal).not.toContainText('in the sandbox');
    await expect(editModal).not.toContainText('the port above');
    await expect(editModal).toContainText('Genie assigns the port');

    // Turn it on and save.
    await toggle.click();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator(MODAL).getByRole('heading', { name: 'Edit web' })).toHaveCount(0);

    // THE assertion the DOM only implies: the update carried browserExposed, so the
    // site now records it — this is exactly what the host reconcile reads to bring
    // up the CA + hosts entry + Caddy :443.
    const site = (await readHostingSites(app)).find((s) => s.id === 'site-web');
    expect(site?.browserExposed, 'toggling on must persist browserExposed').toBe(true);
    // And it rode over the real IPC as an `update`, not some side channel.
    expect((await readHostingState(app))?.calls.site).toContain('update');
});

test('the external-browser toggle is HIDDEN for a container site — never a dead control', async () => {
    // A container site (no hostPort) is served by the SANDBOX Caddy, not the host
    // one, so the toggle would do nothing — and a control that silently does
    // nothing is the bug this gate prevents.
    await seedHostingSites(app, [
        {
            id: 'site-api',
            name: 'api',
            genName: 'api.hosting-e2e.gen',
            repo: '',
            runMode: 'dockerfile',
            kind: 'http',
            enabled: true,
            state: 'running',
            ready: true,
            port: 8000,
        },
    ]);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    const modal = await openPanel(page);

    await modal.getByRole('button', { name: 'Edit' }).click();
    const edit = page.locator(MODAL);
    await expect(edit.getByRole('heading', { name: 'Edit api' })).toBeVisible();
    // No toggle for a container site.
    await expect(
        edit.locator('label.site-field', { hasText: 'Open in a real browser' }),
    ).toHaveCount(0);
});
