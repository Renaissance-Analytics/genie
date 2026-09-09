import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    announceInboxIncoming,
    killMasterTerminals,
    withTeardownBound,
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

    // Two first-run overlays used to be dismissed here, each behind a 20s
    // `waitFor(...).catch(() => {})`. Neither can render on this route any more,
    // so between them they spent 40 fixed seconds of this hook's 60s budget
    // waiting for something that was never coming (genie#356):
    //
    //   - the "Getting the Workstation Ready" walkthrough — `FirstRunOnboarding`
    //     has no mount site; the Genie OS layer asserted on below replaced it;
    //   - the `.toolchain-wizard` — `78cdd904` removed its mount from
    //     `master.tsx`, leaving `settings.tsx` as its only one, a different route.
    //
    // That is why a hook measured at ~42s on a GREEN run had 18s of headroom, and
    // lost it whenever anything varied — a worker restart relaunch, a slow cold
    // boot — surfacing as `"beforeAll" hook timeout of 60000ms` against whichever
    // test was next (genie#490, genie#442).
    //
    // Deleted rather than shortened. A wait guarded by `.catch()` + `if (count)`
    // cannot fail, so it never reported the modal's absence; a smaller timeout
    // would have kept a check that still cannot tell the two states apart.
    // `e2e/helpers/__tests__/master-window-waits-guard.test.ts` now holds the
    // invariant: this hook may only wait for overlays the master route renders,
    // so if either is mounted again its wait has to come back with it.

    // A fresh throwaway profile has never acknowledged this build's curated
    // release notes. They load asynchronously, so dismiss the real dialog here
    // before any test starts driving the workspace behind it.
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

    // The Genie OS first-run layer must NOT be over this window (genie#352).
    //
    // This fixture seeds two REGISTERED workspaces, so the profile is a
    // configured machine and `genieOsStatus()` answers `setup: true`. Until
    // #352 the boot mode came from one dotfile that nothing could ever write,
    // so a profile with workspaces in it was told it had never been set up: the
    // layer raised itself full-screen with `pointer-events: auto` over the
    // sidebar, and the first test that CLICKS a workspace row timed out with
    // the row visible, enabled, stable, and COVERED. Three releases read that
    // as a sidebar regression. This hook used to spend 20 seconds of its 60s
    // budget waiting for that layer so it could dismiss it.
    //
    // Asserted rather than waited for, and asserted in a shape that cannot pass
    // vacuously: the element is rendered unconditionally, so it must be PRESENT
    // (a page that never mounted fails here) and must not carry `is-open`. It
    // runs after the seed read, by which point the window is fully up and the
    // one `genieOsStatus()` round-trip has long since been applied.
    const genieOsLayer = page.locator('.genie-os-layer');
    await expect(genieOsLayer).toHaveCount(1);
    await expect(genieOsLayer).not.toHaveClass(/\bis-open\b/);
});

test.afterAll(async () => {
    // Kill the ptys BEFORE quitting: a manual quit with a live terminal and a
    // window open raises the keep-or-shut-down confirmation, and this harness is
    // the real master page, so it really renders that modal — quit would then sit
    // out its 30s decision timeout with nobody there to answer.
    //
    // BOTH steps are bounded, and each names itself if it overruns (genie#490).
    // This hook blew its 60s on `main` at `7f594b1d` and the failure was
    // reported against test 961, which had passed — so the run read as a Flows
    // palette regression. Neither step was bounded, so the log could not even
    // say which of the two was stuck, and reading the source cannot settle it
    // either: both are plausible against a wedged app.
    //
    // The `.catch(() => {})` that used to guard the first step could not help.
    // It handles a REJECTION; the failure is a promise that never settles, and
    // `await` on one waits forever whatever is chained to it. A rejection
    // handler is not a timeout — the general point, not a fact about ptys.
    if (app) await killMasterTerminals(app).catch(() => {});
    if (app) await withTeardownBound(app.close(), 20_000, 'app.close()').catch(() => {});
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
    // The rail is the sidebar MINIMIZED, so it is only on screen once the sidebar
    // is collapsed — collapsing here is what proves the mark survives the switch
    // rather than living in one of the two renderings.
    await page.locator('.rail-collapse').click();
    await expect(page.locator('.chooser-rail')).toBeVisible();
    await expect(page.locator(`.crail-btn[title*="${seed.peerName}"]`)).toHaveClass(
        /\bws-gapp-dev\b/,
    );
    await expect(page.locator(`.crail-btn[title*="${seed.workspaceName}"]`)).not.toHaveClass(
        /\bws-gapp-dev\b/,
    );
    // Back to the sidebar — every test after this one drives workspace ROWS, and
    // leaving the chooser collapsed would strand them behind a hover flyout.
    await page.locator('.crail-toggle').click();
    await expect(page.locator('.chooser-rail')).toHaveCount(0);

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
    // Genie OS is its own AgentPanel surface and may be mounted alongside the
    // Floor. This assertion is specifically about workspace TERMINAL panels:
    // the active workspace contributes one and the inactive peer contributes
    // none. Keeping the surface qualifier also guards the distinct AgentPanel
    // contract instead of folding system agents back into terminal counts.
    await expect(page.locator('.tpanel.terminal-panel:visible')).toHaveCount(1);

    // A panel with no terminal in it is a box. The floor's job is to host a live
    // shell, so the assertion goes as far as the xterm the panel mounts.
    await expect(panel(seed.terminalLabel).locator('.xterm')).toBeVisible();

    const status = page.locator('.gstatus');
    await expect(status).toContainText('1 panel');
    await expect(status).toContainText('1 project');
    // `live` is workstation-wide, unlike the Floor's panel/project counts. The
    // seeded shell and the always-running Genie OS agent are both live, while
    // only the seeded workspace terminal is laid out above.
    await expect(status).toContainText('2 live');
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

/* ===== The Flow Manager (genie#394) ==================================== */

/**
 * Genie's automation surface, in the window it actually lives in.
 *
 * ## Why these tests are HERE rather than in their own spec
 *
 * They started in `e2e/flow-manager.spec.ts`, which called
 * `launchGenieE2E('master')` a second time. Every spec shares one
 * `--user-data-dir`, and a dozen of them launch and close apps against it
 * happily — but `master` is the heavy one, the real product window with ptys and
 * a terminal host behind it, and a SECOND master app in the same run left this
 * file's `beforeAll` timing out at 60s. Not a slow runner: identical on macOS,
 * Linux and Windows.
 *
 * The launch is the scarce resource, so the tests come to the window rather than
 * the window being booted twice. They are appended LAST and each leaves the
 * flyout closed, so nothing above them sees a changed floor.
 *
 * ## What only an E2E can answer here
 *
 * Two things; the rest is covered in main, where it belongs.
 *
 *  1. **The header button animates.** `main/flows/__tests__/activity.test.ts`
 *     proves the running SET is right and `run-announcement.test.ts` proves the
 *     runtime announces a start for exactly the bodies it executes. Neither can
 *     see a pixel.
 *  2. **The state clears.** A badge that sticks is worse than no badge, and
 *     "stuck" is invisible to a test that only ever looks once.
 *
 * The animation is measured with `getAnimations()` — asking the COMPOSITOR what
 * is actually running, so a rule the stylesheet never applied or a selector that
 * stopped matching comes back as zero. Reading the class back would be a test of
 * the test.
 *
 * Activity is pushed on the REAL `flows:activity` channel by `main/e2e/flows.ts`,
 * which explains there why a genuine run is not used: every built-in body
 * finishes in milliseconds, so racing one would be timing a flicker. Drift
 * between the broadcast and the listener is caught structurally by
 * `main/__tests__/flow-ipc-channels.test.ts`.
 */

const flowsButton = () => page.locator('.gicon.flows-button');

/**
 * The flyout ROOT, not the dialog.
 *
 * `aria-hidden` and the `open` class live on `.docs-flyout-root`; the `<aside>`
 * inside it carries `role="dialog"`. Asserting open/closed on the aside is how
 * the first version of this failed — it has no such attribute, so the very first
 * assertion missed before anything was even clicked.
 */
const flowsRoot = () =>
    page.locator('.docs-flyout-root').filter({ has: page.locator('[aria-label="Flows"]') });
const flowsPanel = () => page.locator('[role="dialog"][aria-label="Flows"]');
const flowRow = (title: string) => flowsPanel().locator('.flowmgr-row', { hasText: title });

/**
 * Open a flow's editor and hand back ITS WINDOW.
 *
 * The editor is a real `BrowserWindow` now, not a card over this one
 * (genie#505), so it is a second Playwright `Page` — subscribed to BEFORE the
 * click, because `waitForEvent` started afterwards can miss a window that opened
 * in between.
 *
 * `open` is the click that causes it, rather than a flow title, because two
 * different things open the same window: Edit on a row, and New Flow.
 */
async function openFlowEditor(open: () => Promise<void>): Promise<Page> {
    const appeared = app.waitForEvent('window');
    await open();
    const win = await appeared;
    await win.waitForLoadState('domcontentloaded');
    // React Flow's own root. The window being there proves nothing — an editor
    // that failed to register its node kinds renders a "Loading…" line in a
    // perfectly good window.
    await expect(win.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    return win;
}

/**
 * What is animating on the Flows icon, split by KIND.
 *
 * `getAnimations()` returns CSS **transitions** as well as CSS animations, and
 * `.gicon` transitions two properties — `background` and `color`, 150ms each —
 * on hover. The first version of this counted everything and went red with
 * `Received: 2`, seven milliseconds after the previous test had clicked the
 * button and left the pointer on it. Two transitioned properties, two effects,
 * 7ms into a 150ms transition: the icon was not animating, it was finishing a
 * hover.
 *
 * Asking the compositor is still the right instrument — it is the only thing
 * that knows whether a rule actually applied, which a class check cannot see —
 * but the question has to name the KIND, or the answer includes everything the
 * element happens to be doing for unrelated reasons.
 *
 * Both lists are returned so a failure says WHAT was running rather than only
 * that something was. That is what turned the last failure from a guess into a
 * measurement, and the next person should not have to re-derive it.
 */
async function flowIconEffects(): Promise<{ animations: string[]; transitions: string[] }> {
    return page.evaluate(() => {
        const el = document.querySelector('.gicon.flows-button');
        if (!el) return { animations: ['NO ELEMENT MATCHED'], transitions: [] };
        const live = el.getAnimations().filter((a) => a.playState === 'running');
        return {
            animations: live
                .filter((a): a is Animation & { animationName: string } => 'animationName' in a)
                .map((a) => a.animationName)
                .sort(),
            transitions: live
                .filter((a): a is Animation & { transitionProperty: string } =>
                    'transitionProperty' in a,
                )
                .map((a) => a.transitionProperty)
                .sort(),
        };
    });
}

/** Push run state from main, exactly as the runtime's callbacks do. */
async function setFlowsRunning(running: string[]): Promise<void> {
    await app.evaluate(({}, ids) => {
        const fixture = (globalThis as Record<string, unknown>).__GENIE_E2E_FLOWS__ as
            | { emit: (running: string[]) => void }
            | undefined;
        if (!fixture) throw new Error('__GENIE_E2E_FLOWS__ missing — seed did not run');
        fixture.emit(ids);
    }, running);
}

async function openFlows(): Promise<void> {
    const cls = (await flowsRoot().getAttribute('class')) ?? '';
    if (!cls.includes('open')) await flowsButton().click();
    await expect(flowsRoot()).toHaveClass(/\bopen\b/);
}

test('the Flows button sits in the icon cluster and opens the manager', async () => {
    await setFlowsRunning([]);
    await expect(flowsButton()).toHaveAttribute('aria-label', 'Flow Manager');
    // Same treatment as its neighbours: it IS a `.gicon`, not a lookalike.
    await expect(flowsButton()).toHaveClass(/\bgicon\b/);

    await expect(flowsRoot()).not.toHaveClass(/\bopen\b/);
    await expect(flowsRoot()).toHaveAttribute('aria-hidden', 'true');
    await flowsButton().click();
    await expect(flowsRoot()).toHaveClass(/\bopen\b/);
    await expect(flowsRoot()).toHaveAttribute('aria-hidden', 'false');

    await page.keyboard.press('Escape');
    await expect(flowsRoot()).not.toHaveClass(/\bopen\b/);
});

test('the Flows icon is still while nothing runs, and animates while one does', async () => {
    await setFlowsRunning([]);
    await expect(flowsButton()).not.toHaveClass(/is-running/);
    // EMPTY, not "does not contain flows-running": an unexpected animation on
    // this icon should fail here too. The transitions are reported in the
    // message so a failure names what was running instead of implying it.
    const still = await flowIconEffects();
    expect(still.animations, `transitions also live: ${still.transitions.join(', ')}`).toEqual([]);

    await setFlowsRunning(['e2e-flow-manual']);
    await expect(flowsButton()).toHaveClass(/is-running/);
    // The control, and it NAMES the animation — "something is animating" is
    // satisfied by the hover transition this test previously mistook for one.
    //
    // Polled rather than sampled: the class lands one style recalc before the
    // animation object exists, and a single read can arrive in the gap.
    await expect
        .poll(async () => (await flowIconEffects()).animations, {
            message: 'the flows-running animation should start when a Flow runs',
        })
        .toEqual(['flows-running']);

    await setFlowsRunning([]);
    await expect(flowsButton()).not.toHaveClass(/is-running/);
    // A stuck badge is worse than no badge. This is what catches one — and it
    // asserts EMPTY rather than "no flows-running", so anything unexpected that
    // starts animating this icon fails here too.
    await expect
        .poll(async () => (await flowIconEffects()).animations, {
            message: 'the flows-running animation must STOP when the run ends',
        })
        .toEqual([]);
});

test('the Flow Manager lists the seeded Flows, and warns about the one that cannot fire', async () => {
    await setFlowsRunning([]);
    await openFlows();

    const tidy = flowRow('Tidy the workspace');
    await expect(tidy).toBeVisible();
    await expect(tidy).toContainText('This machine');
    await expect(tidy).toContainText('When you run it');
    await expect(tidy).toContainText('Never run');

    // Titled, enabled, and incapable of ever running again — the one thing a
    // plain list would never tell you.
    const dead = flowRow('Watch a thing that left');
    await expect(dead.locator('.flowmgr-warn')).toContainText('nothing can start it');
    await expect(dead.locator('.flowmgr-warn')).toContainText('ghost:vanished');

    await page.keyboard.press('Escape');
});

test('the Flow Manager marks the running Flow, and only that one', async () => {
    await openFlows();
    await setFlowsRunning(['e2e-flow-manual']);

    // Both asserted: a row that lit up for every Flow passes the first alone.
    await expect(flowRow('Tidy the workspace')).toHaveClass(/is-running/);
    await expect(flowRow('Watch a thing that left')).not.toHaveClass(/is-running/);

    await setFlowsRunning([]);
    await expect(flowRow('Tidy the workspace')).not.toHaveClass(/is-running/);
    await page.keyboard.press('Escape');
});

test('turning a flow off is one click; turning it back on states what it will do', async () => {
    await setFlowsRunning([]);
    await openFlows();

    const row = flowRow('Tidy the workspace');
    const toggle = row.getByRole('switch');
    const armDialog = page.locator('[role="dialog"][aria-label*="Turn on"]');
    const runButton = row.getByRole('button', { name: /Run .* now/ });
    await expect(toggle).toBeVisible();

    // OFF asks nothing. A machine doing LESS cannot surprise anybody, and a
    // confirm on both directions trains people to click through both.
    await toggle.click();
    await expect(armDialog).toHaveCount(0);

    // The "off" line appearing is evidence the STORE changed and came back on
    // `flows:changed` — it is rendered from the reloaded row, not from a local
    // boolean the renderer flipped.
    //
    // ★ The Run button DELIBERATELY stays. A disarmed flow can still be run by
    // hand: `enabled` governs unattended firing, and a manual run is attended by
    // definition. The old rule meant you had to ARM a flow to try it once —
    // granting standing permission in order to test something.
    await expect(row.locator('.flowmgr-off')).toContainText('turning it on lets it use');
    await expect(row.locator('.flowmgr-off')).toContainText('Issues and security alerts');
    await expect(runButton).toHaveCount(1);

    // ON asks, and says what it will be able to do — derived from the steps on
    // the canvas, so the sentence cannot drift from the flow.
    await toggle.click();
    await expect(armDialog).toBeVisible();
    await expect(armDialog).toContainText('It will be able to use');
    await expect(armDialog).toContainText('Issues and security alerts');
    await expect(armDialog).toContainText('without asking again');
    // The consent must name what the SCOPE confers, not just where the flow
    // lives. "This machine" is a location; acting as the user across every
    // workspace is the thing being agreed to, and it is not visible in the
    // graph — so it is said here or it is not said at all.
    await expect(armDialog).toContainText('as YOU, on the whole machine');
    await expect(armDialog).toContainText('every workspace');

    // Cancel leaves it OFF. A confirmation that arms anyway is worse than none:
    // it teaches the user the dialog is decoration.
    await armDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(armDialog).toHaveCount(0);
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    await armDialog.getByRole('button', { name: 'Turn it on' }).click();
    await expect(armDialog).toHaveCount(0);
    await expect(toggle).toBeChecked();
    // Armed, so the row no longer offers the "turning it on" sentence.
    await expect(row.locator('.flowmgr-off')).toHaveCount(0);

    await page.keyboard.press('Escape');
});

test('a Flow row opens its run history, and says so when there is none', async () => {
    await setFlowsRunning([]);
    await openFlows();

    const row = flowRow('Tidy the workspace');
    await row.locator('.flowmgr-disclose').click();
    await expect(row.locator('.flowmgr-history')).toContainText('Recent runs');
    await expect(row.locator('.flowmgr-history')).toContainText('never run');

    // Leave the window as this file's other tests expect to find it.
    await page.keyboard.press('Escape');
    await expect(flowsRoot()).not.toHaveClass(/\bopen\b/);
});


/* ===== Authoring a Flow (genie#394 phase 2) ============================ */

/**
 * The title the editor is driven to type. Shared with `main/e2e/flows.ts`,
 * which clears any row a crashed run left behind — two rows with one title make
 * `flowRow()` ambiguous and fail a spec that has nothing wrong with it.
 */
const AUTHORED = 'Made in the manager';


/**
 * What only an E2E can answer about authoring.
 *
 * The rules are decided in main and pinned there: `flows/__tests__/store.test.ts`
 * proves a flow is stored disarmed whatever the caller passes, and
 * `flows/__tests__/kinds.test.ts` proves the palette covers every classified
 * Genie tool. Neither can see whether a person can actually REACH any of it —
 * and reaching it is precisely what was broken.
 *
 * These two can:
 *
 *  1. **A flow made in the manager arrives OFF, on a canvas.** The safety
 *     property of the whole feature, end to end through the real store: a unit
 *     test proving `enabled: false` says nothing about a surface that helpfully
 *     flips the switch afterwards. And the canvas being a CANVAS is the other
 *     half — this is where a fallback to a plain React Flow node, or to no
 *     editor at all, would show.
 *  2. **The palette carries Genie's own steps.** For a year it did not: they
 *     were computed in main, served on a channel nothing called, and never
 *     registered with fancy-flow, so every step a person could drag was one the
 *     executor refuses. Main computing the list correctly is exactly what the
 *     unit tests already proved while the product was broken.
 */
test('a flow made in the manager arrives switched off, and opens on a canvas', async () => {
    // ★ This spec used to drive a MODAL FORM — "What it does" as a dropdown with
    // one option, conditions built from selects. That whole surface is gone:
    // Genie's flows are fancy-flow GRAPHS, and the editor is `<FlowEditor>`.
    //
    // What survives is the property the old spec was really about, and it is
    // the one worth keeping: **creating is not arming.** A new flow arrives OFF
    // however it was made.
    await setFlowsRunning([]);
    await openFlows();

    // The canvas, in its own window, not a form and not a card.
    const editor = await openFlowEditor(() => flowsPanel().locator('.flowmgr-new').click());

    await editor.getByLabel('Flow name').fill(AUTHORED);
    await editor.getByRole('button', { name: 'Save' }).click();
    await editor.close();

    // The list catches up on its own: `flows:save` pushes `flows:changed`, and
    // the flyout subscribes to it. Nothing here tells it to reload, so a broken
    // push shows up as this row never arriving.
    const row = flowRow(AUTHORED);
    await expect(row).toBeVisible();
    await expect(row).toContainText('This machine');
    // It is OFF, and nothing along the way asked it to be anything else.
    await expect(row.getByRole('switch')).not.toBeChecked();

    // A starter graph reaches no Genie step, so there is nothing to warn about
    // — and the row must NOT invent a reassurance for that case, which is why
    // this asserts the switch rather than a sentence.
    await row.getByRole('button', { name: `Delete ${AUTHORED}` }).click();
    const deleteDialog = page.locator('[role="dialog"][aria-label*="Delete"]');
    await deleteDialog.getByRole('button', { name: /Delete it/ }).click();
    await expect(flowRow(AUTHORED)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(flowsRoot()).not.toHaveClass(/open/);
});

/**
 * Resize the editor's own BrowserWindow, from MAIN, and report the client width
 * the renderer ended up with.
 *
 * From main because a renderer cannot resize a window it did not open. Reported
 * back because a window manager is allowed to refuse: a runner whose screen is
 * narrower than the size asked for gives a smaller window than requested, and a
 * measurement that assumed otherwise would fail for a reason that has nothing to
 * do with Genie.
 */
async function resizeFlowEditor(editor: Page, width: number, height: number): Promise<number> {
    await app.evaluate(
        ({ BrowserWindow }, size) => {
            const w = BrowserWindow.getAllWindows().find((b) =>
                b.webContents.getURL().includes('flow-editor'),
            );
            if (!w) throw new Error('the flow editor window is not among the open windows');
            w.setSize(size.width, size.height);
        },
        { width, height },
    );
    // Settle on the width the window ACTUALLY got, rather than the one asked
    // for: the resize, the paint and the ResizeObserver are three separate
    // ticks, and a window manager may land somewhere else entirely. Bounded and
    // never throwing — a resize that does not take is something the CALLER
    // decides what to do about, from the number it gets back.
    let last = -1;
    for (let i = 0; i < 20; i += 1) {
        const now = await editor.evaluate(() => window.innerWidth);
        if (now === last) return now;
        last = now;
        await editor.waitForTimeout(100);
    }
    return last;
}

test('the canvas gets the whole window, with both panes docked beside it', async () => {
    // The bug this is the standing answer to, twice over. The editor used to
    // render as `prompt-card flowmgr-canvas` — Genie's ordinary modal, widened
    // once because it inherited `.prompt-card { width: 380px }` and again
    // because the first widening was still not enough. The owner's screenshot is
    // the second attempt, clipping off the bottom of the viewport.
    //
    // `expect(locator('.react-flow')).toBeVisible()` passes against every one of
    // those. An element can be present, visible and 100px wide. So this
    // MEASURES, and it measures the thing that actually goes to zero: fancy-flow
    // gives the palette 216px and the config panel 300px from a fixed grid, and
    // the canvas is the `1fr` between them.
    await setFlowsRunning([]);
    await openFlows();
    const editor = await openFlowEditor(() =>
        flowRow('Tidy the workspace').getByRole('button', { name: /Edit/ }).click(),
    );

    // `page.viewportSize()` is null for an Electron window — there is no
    // emulated viewport — so the window is measured from inside the page.
    const inner = await resizeFlowEditor(editor, 1280, 860);

    // The GitHub Windows runner's screen is 1024x768, and a window manager may
    // refuse to make a window wider than the screen. This test is about what the
    // editor does WITH the room, so a runner that cannot give it the room has
    // nothing to say here — and says so, rather than passing on a narrow window
    // where every assertion below would be about the wrong layout. The docked
    // case still runs on the Linux (1280x1024) and macOS shards, and the NARROW
    // case in the test below runs everywhere.
    test.skip(
        inner < 1100,
        `this runner's screen gives the editor only ${inner}px — not enough to dock both panes`,
    );

    const graphBox = await editor.locator('.react-flow').boundingBox();
    if (!graphBox) throw new Error('no bounding box for the graph canvas');

    // The canvas keeps its minimum (520px, `FLOW_CANVAS_MIN_WIDTH`) with BOTH
    // panes docked beside it — asserted a little under, because a scrollbar and
    // the window's own padding come out of the same width.
    expect(graphBox.width, `graph canvas is only ${graphBox.width}px wide`).toBeGreaterThan(500);
    expect(graphBox.height).toBeGreaterThan(400);

    // ...and both panes are actually there at this width. Without this the
    // canvas could be huge because the editor rendered nothing beside it, which
    // is the failure mode fancy-flow's own media queries produce.
    await expect(editor.locator('.ff-editor__palette')).toBeVisible();
    await expect(editor.locator('.ff-editor__panel-wrap')).toBeVisible();
    // Nothing is floating: the overlay rules key off this attribute, and its
    // absence is what says both panes are in the grid.
    await expect(editor.locator('.floweditor-shell')).not.toHaveAttribute('data-overlay', /.*/);

    await editor.close();
    await page.keyboard.press('Escape');
    await expect(flowsRoot()).not.toHaveClass(/open/);
});

test('a narrow editor gives the panes up rather than the canvas, and hands them back', async () => {
    // The responsive half, and the one that runs on every shard: making a window
    // SMALLER always works, whatever the runner's screen.
    //
    // fancy-flow's own answer to a narrow editor is `display: none` on the panes
    // — the wrong axis (it measures the viewport, and the editor is never the
    // viewport) and one-way, with nothing offering to bring a pane back. A
    // canvas you cannot add a step to is not a smaller editor, it is a broken
    // one, so this asserts the way BACK as hard as it asserts the collapse.
    await setFlowsRunning([]);
    await openFlows();
    const editor = await openFlowEditor(() =>
        flowRow('Tidy the workspace').getByRole('button', { name: /Edit/ }).click(),
    );

    const inner = await resizeFlowEditor(editor, 820, 700);
    // 820 is comfortably inside every runner's screen and inside the window's
    // own 640px minimum, so a failure here is Genie's, not the environment's.
    expect(inner, `the editor window would not narrow — it is ${inner}px`).toBeLessThan(1000);

    // Below 1036px of container the config panel leaves the grid; the palette
    // stays, because a canvas with no palette cannot be added to at all.
    await expect(editor.locator('.ff-editor__panel-wrap')).toHaveCount(0);
    // POSITIVE CONTROL: the editor did not simply stop rendering. An editor that
    // failed to mount satisfies the absence above perfectly.
    await expect(editor.locator('.ff-editor__palette')).toBeVisible();
    await expect(editor.locator('.react-flow')).toBeVisible();

    // And it comes BACK. The toolbar grows a toggle for exactly the panes that
    // are not docked; `data-action` is fancy-flow's own stable handle for one.
    await editor.locator('[data-action="genie-pane-panel"]').click();
    await expect(editor.locator('.ff-editor__panel-wrap')).toBeVisible();

    // Floating, not docked: it is OVER the canvas, which keeps its width. This
    // is the assertion that tells an overlay from a third column — a panel that
    // took a column would have shrunk the graph by 300px.
    const withPanel = await editor.locator('.react-flow').boundingBox();
    if (!withPanel) throw new Error('no bounding box for the narrowed graph canvas');
    expect(
        withPanel.width,
        `graph canvas collapsed to ${withPanel.width}px with the panel open`,
    ).toBeGreaterThan(400);

    // The same toggle puts it away again — a one-way reveal is the bug wearing a
    // different hat.
    await editor.locator('[data-action="genie-pane-panel"]').click();
    await expect(editor.locator('.ff-editor__panel-wrap')).toHaveCount(0);

    await editor.close();
    await page.keyboard.press('Escape');
    await expect(flowsRoot()).not.toHaveClass(/open/);
});

test('the canvas offers Genie’s OWN steps, not just fancy-flow’s builtins', async () => {
    // The bug this is the standing answer to: Genie's node kinds were derived in
    // main, served on an IPC channel nothing called, and never registered with
    // fancy-flow at all — so the palette offered only the 27 builtins, every one
    // of which Genie's executor is designed to REFUSE. The canvas could author
    // only steps that would not run.
    //
    // Asserted through the palette a person actually sees, because a unit test
    // can only prove main COMPUTED the list.
    await setFlowsRunning([]);
    await openFlows();
    const editor = await openFlowEditor(() =>
        flowRow('Tidy the workspace').getByRole('button', { name: /Edit/ }).click(),
    );

    // Both halves. Fancy's kit alone would pass a check for "Branch", and a
    // palette showing only Genie's would mean the builtins went missing.
    await expect(editor.getByText('Terminals', { exact: false }).first()).toBeVisible();
    await expect(editor.getByText('Branch', { exact: false }).first()).toBeVisible();

    await editor.close();
    await page.keyboard.press('Escape');
    await expect(flowsRoot()).not.toHaveClass(/open/);
});

test('the palette offers no step Genie would refuse — not even via search', async () => {
    // The half only an E2E can answer: whether `kindFilter` is actually wired to
    // the editor. `main/` can prove the predicate is right about every kind in
    // the registry; it cannot prove the prop reached `<FlowEditor>`.
    //
    // Genie refuses eighteen of fancy-flow's kinds — three that would HANG a run
    // it cannot resume, and fifteen that would FAIL one. An earlier pass filtered
    // only the three, so SubFlow, For Each, Memory Store and Webhook stayed on
    // the canvas. Those four are named below because they are what the owner
    // actually saw.
    await setFlowsRunning([]);
    await openFlows();
    const editor = await openFlowEditor(() =>
        flowRow('Tidy the workspace').getByRole('button', { name: /Edit/ }).click(),
    );

    const palette = editor.locator('.ff-palette');
    // The LABEL element, not the row. A row renders `label` and `description`
    // together, and Playwright's `hasText` is a case-insensitive substring over
    // the whole thing -- so `hasText: 'Memory Store'` matched Genie's own
    // Knowledge step, whose description calls the knowledge graph a
    // "local knowledge/memory store". That is a real row that SHOULD be there,
    // and the looser locator called it a regression. Exact label match instead.
    const labels = palette.locator('.ff-palette__row-label');

    await expect(labels.filter({ hasText: 'Branch' }).first()).toBeVisible();
    const offered = (await labels.allTextContents()).map((t) => t.trim());

    // POSITIVE CONTROLS, first: an empty or unrendered palette satisfies every
    // absence assertion below without the filter existing at all, and an empty
    // palette is exactly what a filter bug produces.
    expect(offered).toContain('Branch');
    expect(offered).toContain('Merge');
    expect(offered).toContain('Transform');
    expect(offered.length, `palette offered ${JSON.stringify(offered)}`).toBeGreaterThan(5);

    for (const hidden of [
        // would HANG the run
        'Human Approval',
        'User Input',
        'Rich User Input',
        // would FAIL it -- the first four are the owner's screenshot
        'SubFlow',
        'For Each',
        'Memory Store',
        'Webhook',
        'API Request',
        'LLM Call',
    ]) {
        expect(offered, `palette still offers "${hidden}"`).not.toContain(hidden);
    }

    // `kindFilter` runs BEFORE the palette's search box -- it filters the full
    // list, and the query narrows what is left. A filter applied the other way
    // round would look identical until somebody typed the name, so this is the
    // assertion that tells the two apart.
    const search = palette.getByPlaceholder(/Search nodes/i);
    await search.fill('memory store');
    expect((await labels.allTextContents()).map((t) => t.trim())).not.toContain('Memory Store');

    // ...and the search box still works, so the absence above is a hidden kind
    // rather than a query that matches nothing.
    await search.fill('branch');
    await expect(labels.filter({ hasText: 'Branch' }).first()).toBeVisible();

    await editor.close();
    await page.keyboard.press('Escape');
    await expect(flowsRoot()).not.toHaveClass(/open/);
});

/**
 * ONE UPDATE CONTROL, AND IT IS THE GENIE LABEL (genie#565).
 *
 * Two controls used to render for the same `ready-to-restart` state and call
 * the same `updater.restart()`: the title-bar pill and a full-width
 * "Restart & update" banner under the header. The owner asked for one, on the
 * wordmark, reading the running version until there is something to install.
 *
 * The wording of every state is settled without a DOM in
 * `renderer/lib/__tests__/header-update-label.test.ts`. What only the real
 * window can show is that the control MOVED — that it is inside `.glogo`, that
 * nothing renders it a second time, and that the deleted banner has no
 * stylesheet or mount left behind.
 *
 * Deliberately indifferent to whether an update happens to be on offer while
 * this runs. The updater is NOT mocked on this route, so it polls GitHub for
 * real and either answer is legitimate — a test that demanded the idle branch
 * would fail on the day a release lands, which is a test about the weather.
 */
test('the Genie label carries the one update control, and the banner is gone', async () => {
    const glogo = page.locator('.glogo');
    await expect(glogo).toBeVisible();

    // Exactly one of the two branches renders, and it is inside the wordmark.
    const version = glogo.locator('.glogo-version');
    const offer = glogo.locator('.update-pill');
    await expect
        .poll(async () => (await version.count()) + (await offer.count()))
        .toBe(1);

    // The duplicate is gone — no mount, and no orphaned stylesheet rule that
    // would let it come back looking styled.
    await expect(page.locator('.update-banner')).toHaveCount(0);
    const bannerStyled = await page.evaluate(() =>
        [...document.styleSheets].some((sheet) => {
            try {
                return [...sheet.cssRules].some((rule) =>
                    (rule as CSSStyleRule).selectorText?.includes('update-banner'),
                );
            } catch {
                // A cross-origin sheet we cannot read contributes nothing rather
                // than failing the check for the wrong reason.
                return false;
            }
        }),
    );
    expect(bannerStyled, '.update-banner still has stylesheet rules').toBe(false);

    // And it no longer sits loose in the title bar beside the icon cluster.
    await expect(page.locator('.titlebar .update-pill')).toHaveCount(0);

    // When nothing is pending the label states what is RUNNING — the half of
    // the ask that makes the wordmark worth reading. Checked against the app's
    // own version rather than a regex, so a label showing some other build's
    // number could not pass.
    if ((await version.count()) === 1) {
        const running = await app.evaluate(({ app: electronApp }) =>
            electronApp.getVersion(),
        );
        await expect(version).toHaveText(`v${running}`);
    } else {
        // The other branch: an offer names a version, and it is not the one
        // already running — "Upgrade to" the build you have is the bug this
        // wording replaces.
        await expect(offer).toHaveText(/\S/);
    }
});
