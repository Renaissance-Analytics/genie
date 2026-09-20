import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    killMasterTerminals,
    launchGenieE2E,
    readLiveTerminals,
    readMasterSeed,
    withTeardownBound,
    type MasterSeed,
} from './helpers/launch';

/**
 * HIBERNATE A WHOLE WORKSPACE, from the window (genie#672).
 *
 * The owner: "I also need a way to hibernate a whole workspace. A Hibernated
 * workspace is styled grey with a set of 3 zzz in front of the agent avatar with
 * each z a little bigger in size. Hibernated workspaces have all processes and
 * terminals completely shut down and do not wake up after upgrades or restarts,
 * only when a user manually wakes them up."
 *
 * This drives the REAL master window against the REAL main process: the menu
 * item, the confirm, `workspaces:hibernate`, the pty that actually dies, and the
 * rail and floor afterwards. Nothing is stood in for — the seeded workspace's
 * terminal is a real pty, and the assertion that it is gone is read from main's
 * own live-terminal list, not from the DOM.
 *
 * What is NOT here is the restart: "do not wake up after upgrades or restarts" is
 * a boot-path decision, covered by main's unit tests (the dev-server lifecycle's
 * boot skip, the scheduler's arming, the supervisor's autostart) because a second
 * app launch inside one spec is the flakiest thing this suite has ever had.
 */

let app: ElectronApplication;
let page: Page;
let seed: MasterSeed;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master'));

    const whatsNew = page.locator('.whats-new-backdrop');
    await whatsNew.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await whatsNew.count()) {
        await page.getByRole('button', { name: 'Got it' }).click();
        await expect(whatsNew).toHaveCount(0);
    }

    const seeded = await readMasterSeed(app);
    if (!seeded) {
        throw new Error(
            'the master fixture never published its seed — the window is showing whatever the profile already held, so nothing below would mean anything',
        );
    }
    seed = seeded;
});

test.afterAll(async () => {
    if (app) await killMasterTerminals(app).catch(() => {});
    if (app) await withTeardownBound(app.close(), 20_000, 'app.close()').catch(() => {});
});

const railRow = (name: string) => page.locator('.tproj-head').filter({ hasText: name });
const workspaceBlock = (name: string) =>
    page.locator('.tproj').filter({ has: page.locator('.tproj-head', { hasText: name }) });
/**
 * The panel rows the rail lists for a workspace, and the ones it lists under
 * Unattached. Scoped through `workspaceBlock`, which the rest of this spec
 * already proves resolves — a bare `.chooser .tterm` matched NOTHING, so the
 * assertions built on it were passing or failing for reasons unrelated to
 * hibernation (genie#723).
 */
const unattachedPanels = () => workspaceBlock('Unattached').locator('.tterm');

/** The workspace context menu. Scoped, because the floor offers Wake too. */
const menu = () => page.locator('.proj-popover');

async function openWorkspaceMenu(name: string): Promise<void> {
    await railRow(name).locator('.pname').click({ button: 'right' });
    await expect(menu()).toBeVisible();
}

test('hibernating a workspace greys it, marks it with three z\'s, and really stops its terminals', async () => {
    const block = workspaceBlock(seed.workspaceName);

    // POSITIVE CONTROL — awake: no z's, no grey, and its pty is running. Without
    // this every assertion below would also pass against a workspace that never
    // had anything to stop.
    await expect(block).not.toHaveClass(/\bis-hibernated\b/);
    await expect(block.locator('.ws-zzz')).toHaveCount(0);
    // POSITIVE CONTROL for the Unattached assertions below: while the workspace
    // is awake its terminal is NOT a leftover, and Unattached does not claim it.
    await expect(unattachedPanels().filter({ hasText: seed.terminalLabel })).toHaveCount(0);
    expect(await readLiveTerminals(app)).toContain(seed.terminalId);

    await openWorkspaceMenu(seed.workspaceName);
    await menu().getByRole('button', { name: 'Hibernate workspace' }).click();

    // The confirm says what it costs; hibernation is a shutdown, not a toggle.
    const confirm = page.locator('.prompt-card');
    await expect(confirm).toContainText(`Hibernate ${seed.workspaceName}?`);
    await confirm.getByRole('button', { name: 'Hibernate' }).click();

    // IT LEAVES THE RAIL (genie#705). Hibernating a workspace is how you get it
    // out of the way, so the row goes — that is the first thing to be true, and
    // it is why the grey row has to be REVEALED before anything can assert on it.
    await expect(block).toHaveCount(0, { timeout: 60_000 });

    // Its panels close with it. The specs remain persisted so Wake can restore
    // them, but a sleeping workspace's panel must not be reclassified as a real
    // unattached panel just because its workspace row is hidden.
    // THE BUG (genie#723): once #705 hid hibernated rows, the grouping had no
    // bucket for their specs and filed them under Unattached — so a sleeping
    // workspace's panels were still listed, just under the wrong heading.
    await expect(unattachedPanels().filter({ hasText: seed.terminalLabel })).toHaveCount(0);

    // The control says how many it is hiding, then shows them.
    const reveal = page.locator('.rail-hibernated-toggle');
    await expect(reveal).toHaveAttribute('aria-label', /Show 1 hibernated workspace\b/);
    await reveal.click();

    // GREY, with three z's — each bigger than the last — in front of the agents.
    await expect(block).toHaveClass(/\bis-hibernated\b/, { timeout: 60_000 });
    // Revealing the grey workspace row does not wake it or reopen its panels.
    await expect(unattachedPanels().filter({ hasText: seed.terminalLabel })).toHaveCount(0);
    const zzz = block.locator('.ws-zzz');
    await expect(zzz).toBeVisible();
    await expect(zzz.locator('span')).toHaveCount(3);
    const sizes = await zzz.locator('span').evaluateAll((els) =>
        els.map((el) => parseFloat(getComputedStyle(el).fontSize)),
    );
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);

    // "all processes and terminals completely shut down" — main's own list, not
    // a panel that merely stopped being rendered.
    await expect
        .poll(async () => await readLiveTerminals(app), { timeout: 30_000 })
        .not.toContain(seed.terminalId);
});

/** Hibernated workspaces are hidden by default (genie#705) — make sure they are
 *  showing, whatever the previous test left behind. */
async function revealHibernated(): Promise<void> {
    const reveal = page.locator('.rail-hibernated-toggle');
    if ((await reveal.count()) === 0) return; // nothing hibernated to reveal
    if ((await reveal.getAttribute('aria-pressed')) !== 'true') await reveal.click();
}

test('the floor of a sleeping workspace says so, and is the way to wake it', async () => {
    await revealHibernated();
    // POSITIVE CONTROL, and the reason it is first: the OTHER workspace still
    // opens its panel while its neighbour sleeps — hibernating one workspace
    // must not disturb the rest — and it proves this window mounts panels at
    // all, so the "no panel" assertion below cannot pass on a dead window.
    await railRow(seed.peerName).locator('.pname').click();
    const peerPanel = page.locator('.tpanel').filter({ hasText: seed.peerTerminalLabel });
    await expect(peerPanel).toBeVisible();

    await railRow(seed.workspaceName).locator('.pname').click();

    const floor = page.locator('.hibernated-floor');
    await expect(floor).toBeVisible();
    await expect(floor).toContainText(`${seed.workspaceName} is hibernating`);
    // Its own panels are UNMOUNTED: a mounted one asks main for a pty as it
    // mounts, and in a sleeping workspace that is refused.
    await expect(page.locator('.tpanel').filter({ hasText: seed.terminalLabel })).toHaveCount(0);
    // The peer's stays mounted behind this floor (hidden, off-workspace) so its
    // pty survives the switch.
    await expect(peerPanel).toHaveCount(1);

    // The menu offers waking, and stops offering the things a sleeping workspace
    // cannot do.
    await openWorkspaceMenu(seed.workspaceName);
    await expect(menu().getByRole('button', { name: 'Wake workspace' })).toBeVisible();
    await expect(menu().getByRole('button', { name: 'Add Terminal', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await floor.getByRole('button', { name: 'Wake workspace' }).click();
    await expect(workspaceBlock(seed.workspaceName)).not.toHaveClass(/\bis-hibernated\b/, {
        timeout: 60_000,
    });
    await expect(page.locator('.ws-zzz')).toHaveCount(0);
    await expect(floor).toHaveCount(0);

    // Awake means its work comes back: the panel mounts again and its terminal
    // is running, which is the whole point of waking rather than un-greying.
    await expect(page.locator('.tpanel').filter({ hasText: seed.terminalLabel })).toBeVisible({
        timeout: 30_000,
    });
    await expect(unattachedPanels().filter({ hasText: seed.terminalLabel })).toHaveCount(0);
    await expect
        .poll(async () => await readLiveTerminals(app), { timeout: 30_000 })
        .toContain(seed.terminalId);
});
