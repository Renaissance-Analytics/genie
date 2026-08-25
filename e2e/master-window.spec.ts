import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    killMasterTerminals,
    launchGenieE2E,
    readLiveTerminals,
    readMasterSeed,
    readPtyGrid,
    type MasterSeed,
} from './helpers/launch';

/**
 * THE MASTER WINDOW — Genie's actual main window, end to end (genie#228).
 *
 * Every other spec in this suite mounts a component on a harness page. This one
 * mounts the PRODUCT: `showE2EWindow` loads `${page}.html`, so pointing it at
 * `master` opens `renderer/pages/master.tsx` itself — the window a user looks at,
 * reading the same database through the same IPC. Until now nothing covered it at
 * all, which is a strange gap for the surface that hosts everything else.
 *
 * ONE THING IS STOOD IN FOR: the sign-in read. The page returns early to
 * `SignInPrompt` when the auth check says signed-out, and the E2E profile is a
 * throwaway with no session — so `main/e2e/mock.ts` answers `auth:whoami` with a
 * connected backend under this page and nothing else. The workspaces, the specs,
 * the layout restore, the panels and the ptys are all real (main/e2e/master.ts
 * only puts rows in the database).
 *
 * The last test is the one worth having. genie#229 was reported as terminal
 * output coming back mangled after a workspace switch: off-workspace panels stay
 * mounted-hidden so their ptys survive, a hidden element measures 0×0, and the
 * refit-on-resize pushed that nonsense geometry through to the pty — which a TUI
 * answers by REFLOWING its scrollback to a width the window never had. That is
 * invisible in a screenshot taken after the panel comes back; what gives it away
 * is the geometry the pty was told while it was off screen, which is what this
 * asserts.
 */

let app: ElectronApplication;
let page: Page;
let seed: MasterSeed;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master'));

    // A machine missing dev tools is offered the first-run toolchain setup, raised
    // over the whole window — and a clean CI runner is exactly the machine that
    // offer exists for, so it opens on every leg. It is real behaviour with a story
    // of its own; here it is a modal standing in front of the window under test,
    // and on macOS its backdrop swallowed the click that switches workspaces.
    //
    // Closed the way a user closes it: that button records the dismissal, so it
    // cannot come back later in the session. Reloading into a pre-set dismissal
    // flag also works and is one line shorter — but it tears the freshly-created
    // pty down mid-handshake, and the Windows leg then had no terminal at all.
    const wizard = page.locator('.toolchain-wizard');
    await wizard.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await wizard.count()) {
        await wizard.getByRole('button', { name: /^(Close|Done)$/ }).click();
        await expect(wizard).toHaveCount(0);
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
    // Kill the ptys BEFORE quitting: a manual quit with a live terminal and a
    // window open raises the keep-or-shut-down confirmation, and this harness is
    // the real master page, so it really renders that modal — quit would then sit
    // out its 30s decision timeout with nobody there to answer.
    if (app) await killMasterTerminals(app).catch(() => {});
    await app?.close();
});

/** A panel by the terminal label its head shows. */
const panel = (label: string) => page.locator('.tpanel').filter({ hasText: label });

/** A workspace row in the rail, by project name. */
const railRow = (name: string) => page.locator('.tproj-head').filter({ hasText: name });

/**
 * Switch to a workspace the way the UI actually offers it — by its NAME.
 *
 * NOT `railRow(name).click()`, which is what this used to be. Playwright clicks
 * the CENTRE of an element's bounding box, and `.tproj-head` is a button that
 * happens to contain several `<span role="button">` controls — the IssueWatch
 * pill, Processes, Sites, and now the GApp launcher — each of which deliberately
 * calls `stopPropagation()` so it can act without also activating the workspace.
 * `.pname` is `flex: 1`, so it absorbs whatever those controls leave.
 *
 * That made the centre of the box an INCIDENTAL coordinate. It sat inside
 * `.pname` only for as long as the control cluster stayed narrow enough, and a
 * fourth control moved `.pname`'s right edge from ~198px to ~177px while the
 * centre stayed at ~191px. The click then landed on the IssueWatch pill, which
 * swallowed it: the workspace never switched, and `panels` stayed at 1.
 *
 * The centre was never the switch affordance and nothing promised it would be —
 * so this clicks the name, which is. Any control added to this row from now on
 * moves that centre again; none of them move the name.
 */
const switchToWorkspace = (name: string) => railRow(name).locator('.pname').click();

test('the window comes up signed in, on the real two-column frame', async () => {
    // Either branch of the page renders `.winframe`, so this waits for the window
    // to have decided which one — and the sign-in assertion below is then a real
    // assertion rather than one that passed because nothing had rendered yet.
    await expect(page.locator('.winframe')).toBeVisible();

    // The blocker this gate had to solve. Signed out, the page returns a stacked
    // frame around `SignInPrompt` and every assertion below is unreachable.
    await expect(page.getByText('Connect Genie')).toHaveCount(0);
    await expect(page.locator('.winframe.stacked')).toHaveCount(0);

    // The three parts of the frame: the full-height chooser column, the floor's
    // grid, and the floor's status bar.
    await expect(page.locator('.gleft')).toBeVisible();
    await expect(page.locator('.gbody')).toBeVisible();
    await expect(page.locator('.gstatus')).toBeVisible();
});

test('the rail lists the seeded workspaces, with the launch target active', async () => {
    await expect(railRow(seed.workspaceName)).toBeVisible();
    await expect(railRow(seed.peerName)).toBeVisible();

    // `active_workspace` is what the launch restore prefers, so the fixture's
    // workspace — not whichever row happens to sort first — fills the floor.
    await expect(
        page.locator('.tproj.is-active').filter({ hasText: seed.workspaceName }),
    ).toHaveCount(1);
});

/**
 * A GApp Development Workspace looks different, and an ordinary one does not
 * (genie#245).
 *
 * The precedence and the manifest boundary are settled in unit tests
 * (renderer/lib/__tests__/workspace-kind.test.ts). What only the real window can
 * show is that the resolved class actually REACHES the DOM and that a stylesheet
 * answers it — a frozen lookup table returning 'ws-gapp-dev' is worth nothing if
 * nobody applies it or no rule matches.
 *
 * The ordinary workspace in the same rail is the control, and it is what makes
 * this test non-vacuous: every assertion here would also pass against a build
 * that dropped the feature entirely if it only ever asked about one row.
 */
test('a GApp Development Workspace wears its own chrome; an ordinary one does not', async () => {
    const gdwRow = page.locator('.tproj').filter({ hasText: seed.peerName });
    const plainRow = page.locator('.tproj').filter({ hasText: seed.workspaceName });

    await expect(gdwRow).toHaveClass(/\bws-gapp-dev\b/);
    await expect(plainRow).not.toHaveClass(/\bws-gapp-dev\b/);

    // …and the same mark on the 56px rail, which identifies workspaces on its own.
    await expect(page.locator(`.crail-btn[title*="${seed.peerName}"]`)).toHaveClass(
        /\bws-gapp-dev\b/,
    );
    await expect(page.locator(`.crail-btn[title*="${seed.workspaceName}"]`)).not.toHaveClass(
        /\bws-gapp-dev\b/,
    );

    // The class is only half of it. A rule has to MATCH, so compare what the two
    // rows actually paint: the GDW's header carries a ring the ordinary one does
    // not. Reading computed style rather than a screenshot keeps this honest about
    // WHY they differ and survives theme changes.
    const ringOf = (row: typeof gdwRow) =>
        row.locator('.tproj-head').first().evaluate((el) => getComputedStyle(el).boxShadow);
    const gdwRing = await ringOf(gdwRow);
    const plainRing = await ringOf(plainRow);
    expect(gdwRing).not.toBe(plainRing);
    expect(gdwRing).not.toBe('none');

    // The tooltip is where the ring says what it MEANS — a colour nobody can name
    // is decoration, not information.
    await expect(gdwRow.locator('.tproj-head').first()).toHaveAttribute(
        'title',
        /GApp Development Workspace/,
    );
});

/**
 * THE ROW DOES TWO THINGS, AND A 13px TARGET DECIDES WHICH (genie#245).
 *
 * A GDW's row is a workspace switch that also carries a launcher for the app the
 * workspace builds. Nothing tested that those two stay separate, and the cost of
 * getting it wrong is not symmetric: switching when you meant to launch is a
 * shrug, and launching when you meant to switch opens a real app window, starts
 * its agents, and puts a permissions modal in front of someone who was trying to
 * change project.
 *
 * This is also the property the genie#229 failure was really about. That test
 * clicked the CENTRE of the row's bounding box, which was never the switch
 * affordance — it sat inside `.pname` only by the grace of the control cluster
 * being narrow, and a fourth control pushed the name's right edge past it so the
 * IssueWatch pill ate the click. The row was behaving exactly as designed; the
 * test was resting on a coordinate nothing promised.
 *
 * The launch is asserted through its FAILURE on purpose. The fixture folder has a
 * `project.json` but no `genie-app.json`, so the preview refuses with a message
 * instead of opening a real window in CI — which makes the toast a positive
 * control: it proves the control actually fired, so "the workspace did not
 * switch" cannot pass against a button that did nothing at all.
 */
test('on a GDW the row switches and the GApp control launches — never each other', async () => {
    const gdwRow = page.locator('.tproj').filter({ hasText: seed.peerName });
    const plainRow = page.locator('.tproj').filter({ hasText: seed.workspaceName });
    const control = gdwRow.locator('.gapp-ind');

    // The affordance exists here and ONLY here — the ordinary workspace has no app
    // to launch, and a control offering one would be lying.
    await expect(control).toHaveCount(1);
    await expect(plainRow.locator('.gapp-ind')).toHaveCount(0);
    await expect(control).toHaveAttribute('title', /Launch .*Genie App/);

    // Start from a known side: the ordinary workspace is active.
    await switchToWorkspace(seed.workspaceName);
    await expect(plainRow).toHaveClass(/\bis-active\b/);

    // THE LAUNCHER MUST NOT SWITCH. It reports (the folder holds no manifest)…
    await control.click();
    // Filtered rather than asserted on `.g-toast` alone: this window has more than
    // one toast surface, and a bare selector would be a strict-mode violation the
    // day a second one happens to be up.
    await expect(
        page.locator('.g-toast').filter({ hasText: 'genie-app.json' }),
    ).toBeVisible();
    // …and the active workspace is untouched.
    await expect(plainRow).toHaveClass(/\bis-active\b/);
    await expect(gdwRow).not.toHaveClass(/\bis-active\b/);

    // THE ROW MUST STILL SWITCH, with the control sitting right there in it.
    await switchToWorkspace(seed.peerName);
    await expect(gdwRow).toHaveClass(/\bis-active\b/);
    await expect(plainRow).not.toHaveClass(/\bis-active\b/);

    // Leave the fixture as it was found — the tests below start on the ordinary
    // workspace and this file shares one window.
    await switchToWorkspace(seed.workspaceName);
    await expect(plainRow).toHaveClass(/\bis-active\b/);
});

test('the floor lays out the seeded terminal, and the status bar counts it', async () => {
    await expect(panel(seed.terminalLabel)).toBeVisible();
    // Only the ACTIVE workspace's selected specs are laid out; the peer's terminal
    // is not selected yet, so nothing else is mounted.
    await expect(page.locator('.tpanel')).toHaveCount(1);

    // A panel with no terminal in it is a box. The floor's job is to host a live
    // shell, so the assertion goes as far as the xterm the panel mounts.
    await expect(panel(seed.terminalLabel).locator('.xterm')).toBeVisible();

    const status = page.locator('.gstatus');
    await expect(status).toContainText('1 panel');
    await expect(status).toContainText('1 project');
    // `live` drops back to 0 when a panel's terminal EXITS, so this says the shell
    // is still running and not just that a panel was mounted.
    await expect(status).toContainText('1 live');
});

test('a workspace switch never fits the panel it hid (genie#229)', async () => {
    // Two stages, so a failure says which half broke rather than "no grid".
    // First: main has a live pty for this spec at all.
    await expect
        .poll(() => readLiveTerminals(app), {
            message: 'main never had a live pty for the fixture terminal — the shell did not start, or started and exited',
            timeout: 30_000,
        })
        .toContain(seed.terminalId);
    // Then: a grid was applied to it. The create round-trip sends one as soon as
    // it lands, so this is only ever a short wait behind the spawn.
    await expect
        .poll(() => readPtyGrid(app, seed.terminalId), {
            message: 'the pty is live but was never given a grid',
            timeout: 30_000,
        })
        .not.toBeNull();
    const onScreen = (await readPtyGrid(app, seed.terminalId))!;

    // The grid a VISIBLE panel measured. Stated as its own assertion because the
    // failure means something specific: a terminal that is on screen and was told
    // it has a handful of columns has already been fitted against something that
    // was not its container.
    expect(onScreen.cols, 'a visible panel was fitted to a grid no window has')
        .toBeGreaterThan(20);
    expect(onScreen.rows).toBeGreaterThan(4);

    // Switch away. The panel is not unmounted — it is kept mounted-hidden so its
    // pty survives — and a hidden element measures 0×0.
    await switchToWorkspace(seed.peerName);
    await expect(panel(seed.terminalLabel)).toBeHidden();
    await expect(panel(seed.peerTerminalLabel)).toBeVisible();

    // This asserts a NON-event, so it has to give the bad path time to happen:
    // the collapse fires a ResizeObserver, which fits on the next frame and sends
    // the resize over IPC. Without the guard the pty has the nonsense geometry
    // well inside this window; with it, nothing is sent at all.
    await page.waitForTimeout(1500);
    expect(await readPtyGrid(app, seed.terminalId)).toEqual(onScreen);

    // Back again. The panel is on screen at the size it left, and the terminal
    // still measures its container rather than whatever it was told while hidden.
    await switchToWorkspace(seed.workspaceName);
    await expect(panel(seed.terminalLabel)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await readPtyGrid(app, seed.terminalId)).toEqual(onScreen);

    // And on screen: the rendered terminal fills its panel body. A terminal left
    // wrapped at a width the window never had draws in a sliver down one side,
    // which no assertion about counts would notice.
    const host = await panel(seed.terminalLabel).locator('.term-host').boundingBox();
    const screen = await panel(seed.terminalLabel).locator('.xterm-screen').boundingBox();
    expect(host).not.toBeNull();
    expect(screen).not.toBeNull();
    expect(screen!.width).toBeGreaterThan(host!.width - 40);
});
