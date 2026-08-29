import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    announceInboxIncoming,
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

    // The throwaway profile deliberately starts without the first-run marker.
    // This fixture already contains registered workspaces, so the supported
    // returning-user path is to dismiss onboarding and continue into the
    // existing workspace. Exercise that real path instead of mutating
    // localStorage behind the product's back.
    const onboarding = page
        .locator('[data-react-fancy-modal]')
        .filter({ hasText: 'Getting the Workstation Ready' });
    await onboarding.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await onboarding.count()) {
        await page.keyboard.press('Escape');
        await expect(onboarding).toHaveCount(0);
    }

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

test('the floor lays out the seeded terminal, and the status bar counts it', async () => {
    await expect(panel(seed.terminalLabel)).toBeVisible();
    // Only the ACTIVE workspace's selected specs are laid out; the peer's terminal
    // is not selected yet, so nothing else is mounted.
    //
    // ORDERING: this has to run BEFORE anything activates the peer workspace. A
    // visited workspace's panel is kept mounted-hidden so its pty survives, so the
    // count never comes back down and switching back does not restore it. Put any
    // test that switches workspaces AFTER this one.
    // Genie OS is an always-mounted flyout AgentPanel, but it is not part of
    // the workspace Floor while closed. Count what the user can actually see,
    // not hidden system chrome outside the active workspace.
    await expect(page.locator('.tpanel:visible')).toHaveCount(1);

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
 * PLACED LAST, and that placement is load-bearing. Off-workspace panels are
 * kept MOUNTED-hidden so their ptys survive — the premise of the genie#229
 * test above — so ACTIVATING a workspace mounts its panel permanently and
 * `.tpanel` never comes back down. This test switches workspaces, so anywhere
 * earlier it raises the panel count under "the floor lays out the seeded
 * terminal", which counts on the peer never having been visited. Switching
 * back does not undo it: the active workspace is not the state that leaks —
 * the MOUNT is. That cost a red build to learn, so it is written down here.
 *
 * The launch is asserted through its FAILURE on purpose. The fixture folder has a
 * `project.json` but no `gapp.json`, so the preview refuses with a message
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
        page.locator('.g-toast').filter({ hasText: 'gapp.json' }),
    ).toBeVisible();
    // …and the active workspace is untouched.
    await expect(plainRow).toHaveClass(/\bis-active\b/);
    await expect(gdwRow).not.toHaveClass(/\bis-active\b/);

    // THE ROW MUST STILL SWITCH, with the control sitting right there in it.
    await switchToWorkspace(seed.peerName);
    await expect(gdwRow).toHaveClass(/\bis-active\b/);
    await expect(plainRow).not.toHaveClass(/\bis-active\b/);

    // Leave the window on the ordinary workspace, as this file's other tests do.
    await switchToWorkspace(seed.workspaceName);
    await expect(plainRow).toHaveClass(/\bis-active\b/);
});

/**
 * THE GAPP STORE LISTS THE APP THIS WORKSPACE BUILDS, RIBBONED.
 *
 * A developer building a GApp is also a user who installs the released one, and
 * both are meant to exist at once — so the store shows both, in one list, and
 * the ribbon is the only thing keeping two nearly-identical rows apart. Which
 * entries exist and which wear a ribbon is settled in unit tests
 * (renderer/lib/__tests__/gapp-store.test.ts), including the manifest boundary.
 * What ONLY the real window can show is that the frozen table's class reaches
 * the DOM and that a stylesheet answers it — a lookup returning
 * 'store-gapp-dev' is worth nothing if nobody applies it or no rule matches.
 *
 * The ordinary workspace is the control, and it is what stops this passing
 * against a build that lists nothing: the same list is asked about both rows.
 *
 * PLACED LAST for the same reason the test above is — this file shares one
 * window, and the test above leaves a toast and an active workspace behind. This
 * one waits that toast out rather than reading it, which is what makes the toast
 * it asserts a report of ITS OWN click.
 */
test('the GApp Store lists a ribboned dev launcher, and launching it previews', async () => {
    // Any toast the launcher test left is still on screen for up to 4s and says
    // exactly what this test is about to assert. Waiting it out is the difference
    // between proving this button fired and re-reading the last one's receipt.
    const refusal = page.locator('.g-toast').filter({ hasText: 'gapp.json' });
    await expect(refusal).toHaveCount(0, { timeout: 10_000 });

    await page.getByRole('button', { name: 'Genie Apps' }).click();
    const list = page.getByTestId('gapp-store-list');
    await expect(list).toBeVisible();

    // THE ENTRY. It is in the store's ONE list — not a section of its own — which
    // is the whole point: a developer finds their own app where they already look
    // for everyone else's.
    const devEntry = list.locator('.plugin-card').filter({ hasText: seed.peerName });
    await expect(devEntry).toHaveCount(1);
    await expect(devEntry).toHaveClass(/\bstore-gapp-dev\b/);
    // The ribbon SAYS what the colour means. A hue nobody can name is decoration.
    await expect(devEntry).toContainText('dev launcher');
    // …and it names the folder, which is what settles it when an installed app
    // and a launcher carry the same name.
    await expect(devEntry).toContainText(seed.peerPath);

    // THE CONTROL. The ordinary workspace builds nothing, so it gets no entry —
    // and because the GDW above DOES have one in this same list, "no entry" is a
    // filter doing its job rather than an empty drawer.
    await expect(list.locator('.plugin-card').filter({ hasText: seed.workspaceName })).toHaveCount(
        0,
    );

    // THE RULE MATCHED, not just the class landed. An unribboned `.plugin-card`
    // paints a flat colour, so `background-image` is 'none'; the ribboned one
    // pours the GDW gradient out of its leading edge, and the edge itself is a
    // real painted bar in the GDW pink. Reading computed style rather than a
    // screenshot keeps this honest about WHY it differs and survives a retheme.
    const paint = await devEntry.evaluate((el) => ({
        card: getComputedStyle(el).backgroundImage,
        bar: getComputedStyle(el, '::before').backgroundColor,
    }));
    expect(paint.card).not.toBe('none');
    expect(paint.bar).toBe('rgb(236, 72, 153)');

    // LAUNCHING FROM HERE IS THE SAME LAUNCH. The fixture folder has a
    // `project.json` and no `gapp.json`, so the preview refuses with a
    // message instead of opening a real window in CI — which makes the toast a
    // positive control (the button really fired) AND the evidence that the store
    // goes through the same `openPreview` the workspace row does, since it comes
    // back with the row's own refusal rather than one of its own.
    await devEntry.getByRole('button', { name: /Launch/ }).click();
    await expect(refusal).toBeVisible();

    // Leave the window as the rest of the file expects it: no drawer open. Scoped
    // to the drawer — 'Close' is a common label and a bare lookup would be a
    // strict-mode violation the day another surface is up alongside it.
    await page.getByTestId('gapp-store').getByRole('button', { name: 'Close' }).click();
    await expect(list).toHaveCount(0);
});

/**
 * THE INCOMING-MESSAGE TOAST MUST NAME ITS TERMINAL, AND OPEN IT.
 *
 * Owner, verbatim: *"I just got the notice that a message was incoming but it
 * never ever came and I hit enter like it said but nothing happened. my cursor
 * was in the input, but nothing was typed. I think it confused focus with
 * content"*.
 *
 * It did. `broadcastInboxIncoming` sent `{ id }`, master.tsx discarded it, and
 * the toast was one fixed sentence — "A message just came in for THIS agent …
 * press Enter to deliver it". The notice itself had been appended to the
 * ADDRESSEE's prompt, which is routinely a terminal in another workspace, so
 * "this agent" pointed at whatever had focus and Enter went into an empty box.
 *
 * The unit tests settle what the notice SAYS (attention/inbox-incoming-notice)
 * and what goes on the wire (terminal/inbox-incoming-broadcast). Only the real
 * window can show the payload SURVIVING to the DOM and the click going
 * somewhere — a frozen `planInboxIncomingNotice` is worth nothing if the page
 * throws its result away again, which is precisely what it used to do.
 *
 * The toast is raised for the PEER workspace's terminal while the window sits on
 * the ordinary one: same-workspace would prove nothing, because a toast that
 * named the wrong terminal would still look right.
 *
 * PLACED LAST for this file's standing reason — the reveal ACTIVATES a
 * workspace, and a visited workspace's panel stays mounted-hidden forever, so
 * anywhere above "the floor lays out the seeded terminal" this breaks that
 * test's panel count.
 *
 * It also runs after two tests that leave a `.g-toast` refusal on screen, which
 * is why every assertion here goes through the `agentinbox-incoming` TEST ID
 * rather than `.g-toast`. This window has several toast surfaces; a bare class
 * selector would read the previous test's receipt, and would be a strict-mode
 * violation besides.
 */
test('a blocked nudge stays on its terminal and replaces that workspace AgentPulse', async () => {
    const plainRow = page.locator('.tproj').filter({ hasText: seed.workspaceName });
    const gdwRow = page.locator('.tproj').filter({ hasText: seed.peerName });
    const notice = page.getByTestId('agentinbox-incoming');

    // Start on the ordinary workspace: the toast is about the OTHER one.
    await switchToWorkspace(seed.workspaceName);
    await expect(plainRow).toHaveClass(/\bis-active\b/);

    await announceInboxIncoming(app, seed.peerTerminalId, true);
    await expect(gdwRow.locator('.agent-nudge-questions')).toBeVisible();
    await expect(gdwRow.locator('.agent-pulse-spark')).toHaveCount(0);

    // The notice is terminal-scoped, so it remains hidden with that terminal
    // instead of floating globally over whichever workspace happens to be open.
    await expect(notice).toBeHidden();
    await switchToWorkspace(seed.peerName);
    await expect(gdwRow).toHaveClass(/\bis-active\b/);
    await expect(plainRow).not.toHaveClass(/\bis-active\b/);
    await expect(panel(seed.peerTerminalLabel)).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Your input is untouched');
    await expect(notice.getByRole('button', { name: 'Send nudge' })).toBeVisible();

    // The old toast expired after eight seconds. This stays until the pending
    // nudge is explicitly resolved.
    await page.waitForTimeout(8_500);
    await expect(notice).toBeVisible();
    await announceInboxIncoming(app, seed.peerTerminalId, false, false);
    await expect(notice).toHaveCount(0);

    // Leave the window on the ordinary workspace, as this file's other tests do.
    await switchToWorkspace(seed.workspaceName);
    await expect(plainRow).toHaveClass(/\bis-active\b/);
});
