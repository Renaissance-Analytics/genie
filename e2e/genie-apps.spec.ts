import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * E2E for the window a Genie App actually gets (Tynn #250).
 *
 * WHY THIS EXISTS: the unit suite proves the DECISIONS — what the window options
 * are, which navigations are refused, which calls are denied. What it structurally
 * cannot prove is that a real Electron window built from those options behaves the
 * way the options claim. And the single most important property of the whole
 * feature is a NEGATIVE: `window.genie` is absent inside a GApp's page.
 *
 * A negative cannot be established by reading code. Genie's own preload is one
 * path string away, `contextIsolation` is one boolean away, and either mistake
 * leaves every unit test green while handing third-party content the entire
 * desktop API. So this opens the real window, with the real preload, over the real
 * bridge, and asks the page what it can see.
 *
 * The page under test is the SHIPPED example app's front end, not a fixture
 * written to pass — if the reference app stops working, this spec says so.
 */

let app: ElectronApplication;

/** Run an expression INSIDE the app's embedded view, via main. */
const inAppView = <T,>(expression: string): Promise<T> =>
    app.evaluate(
        ({}, expr) =>
            (globalThis as Record<string, any>).__GENIE_E2E_APPS__.evalInAppView(
                'com.genie.example',
                expr,
            ),
        expression,
    ) as Promise<T>;

test.beforeAll(async () => {
    ({ app } = await launchGenieE2E());
    await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_APPS__.openExample(),
    );
    // The view loads asynchronously; wait for its bridge rather than racing it.
    await expect
        .poll(() => inAppView<string>('typeof window.genieApp'), { timeout: 15_000 })
        .toBe('object');
});

test.afterAll(async () => {
    // The agent panels the roster spec starts are REAL agent terminals with REAL
    // ptys, and Genie's default pty-host is DETACHED — it outlives the app on
    // purpose. Every spec here shares one profile directory and they run serially,
    // so anything left running is still holding its port and its MCP endpoint while
    // the NEXT spec boots its own Genie over the same profile. Killing them is part
    // of this spec, not tidiness.
    await app
        ?.evaluate(() =>
            (globalThis as Record<string, any>).__GENIE_E2E_APPS__.killAppPanels(
                'com.genie.harness',
            ),
        )
        .catch(() => 0);
    await app?.close();
});

test('the embedded view renders the app’s own front end', async () => {
    // Proves the VIEW really loaded the served app rather than sitting blank —
    // without which every assertion below would pass vacuously on an empty page.
    expect(await inAppView<string>('document.querySelector("h1")?.textContent ?? ""')).toContain(
        'Genie App Example',
    );
});

test('window.genie is ABSENT — the property the whole model rests on', async () => {
    const seen = await inAppView<Record<string, string>>(
        '({ genie: typeof window.genie, genieApp: typeof window.genieApp,' +
            ' require: typeof window.require, process: typeof window.process,' +
            ' module: typeof window.module })',
    );

    // The bridge is PRESENT. Asserted here, in the same breath, because the first
    // run of this spec passed the absence check on a window where the preload had
    // DIED — a preload that never runs exposes nothing either, so "no
    // window.genie" is exactly what a completely broken bridge looks like.
    expect(seen.genieApp).toBe('object');

    expect(seen.genie).toBe('undefined');
    // And no Node, by any of the usual doors.
    expect(seen.require).toBe('undefined');
    expect(seen.process).toBe('undefined');
    expect(seen.module).toBe('undefined');
});

test('window.genieApp is exactly two calls, and no more', async () => {
    // The surface is meant to be small. A third method appearing here without a
    // deliberate decision is the kind of drift that ends in a wide bridge.
    const keys = await inAppView<string[]>('Object.keys(window.genieApp ?? {}).sort()');
    expect(keys).toEqual(['call', 'me']);
});

test('the app learns who it is — from Genie, not from itself', async () => {
    const me = await inAppView<Record<string, unknown>>('window.genieApp.me()');

    expect(me).toMatchObject({ id: 'com.genie.example', name: 'Genie App Example' });
    // The GRANTED set, not the declared one: the harness declares hosting AND
    // terminals and grants only hosting.
    expect(me.capabilities).toEqual(['hosting']);
});

test('an ungranted call is refused, in words the user could act on', async () => {
    const outcome = await inAppView<{ ok: boolean; error?: string }>(
        'window.genieApp.call("manageTerminals", { action: "list" })',
    );

    expect(outcome.ok).toBe(false);
    // Named by its human label, not its tool id — this string is shown to a person.
    expect(outcome.error).toContain('Run commands');
    expect(outcome.error).toContain('Genie App Example');
});

test('a tool no app may ever use is refused with the standing reason', async () => {
    // `submitFeedback` posts to Tynn in the user's name. There is no permission
    // level at which an app gets it, so the message must not suggest a setting.
    const outcome = await inAppView<{ ok: boolean; error?: string }>(
        'window.genieApp.call("submitFeedback", { text: "hi" })',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/impersonat/i);
});

test('a granted call reaches the real tool', async () => {
    // It may well fail INSIDE the tool — the harness grant points at a workspace
    // that does not exist — but it must get past the gate. A refusal here would
    // mean the granted path never opens, which no negative test can catch.
    const outcome = await inAppView<{ ok: boolean; error?: string }>(
        'window.genieApp.call("manageSite", { action: "list" })',
    );

    expect(String(outcome.error ?? '')).not.toContain('was not granted');
});

test('the page cannot claim to be a different app', async () => {
    // There is no field for it — identity is the window Genie recorded. Sending
    // one anyway must change nothing.
    const me = await inAppView<Record<string, unknown>>(
        'window.genieApp.call("manageSite", { action: "list", appId: "com.attacker.app" })' +
            '.then(() => window.genieApp.me())',
    );

    expect(me.id).toBe('com.genie.example');
});

/**
 * Scaffold → check → install, over the REAL I/O chain.
 *
 * Every unit test of the installer replaces the filesystem and the database with
 * fakes — necessarily, since the assertions that matter there are about calls that
 * must NOT happen. Which leaves the thing nobody had verified: whether an install
 * actually lands. Envelope creation, the file copy, the project.json write, the
 * grant row, and the attempt to bring services and the site up all happen here for
 * real. Only the OS consent modal is substituted; it would block a headless run
 * forever, and what it decides is covered exhaustively in unit tests.
 */
test('a scaffolded app passes Genie’s own check and then installs', async () => {
    const outcome = await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_APPS__.scaffoldCheckInstall(),
    );

    // The scaffold must pass the gate it scaffolds for. If this ever fails, the
    // starting point Genie hands people is one Genie itself rejects.
    expect(outcome.report.errors).toEqual([]);
    expect(outcome.report.ok).toBe(true);

    // And it installs — a real workspace, real files, a real grant row.
    expect(outcome.install.errors ?? []).toEqual([]);
    expect(outcome.install.ok).toBe(true);
    expect(outcome.install.workspaceId).toBeTruthy();
    expect(outcome.install.homeUrl).toBe('https://harness-thing.gen/');

    // And it lands in a `.gapp` envelope. Asserted HERE rather than in a unit test
    // because the unit suite fakes `createWorkspace` outright — the suffix is a
    // one-word argument in the real I/O, and the only place it can be observed is
    // the folder that actually appeared on disk.
    expect(outcome.workspacePath).toMatch(/harness-thing\.gapp$/);
    expect(fs.existsSync(path.join(String(outcome.workspacePath), 'project.json'))).toBe(true);
});

test('the installed app is visible to Genie afterwards, with what it was granted', async () => {
    const listed = await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_APPS__.listInstalled(),
    );

    const harness = listed.find((a: { id: string }) => a.id === 'com.genie.harness');
    expect(harness).toBeTruthy();
    // The scaffold asks for nothing, so the app holds nothing — and the panel has
    // a sentence for exactly that state rather than showing "0 of 0".
    expect(harness.permissions).toEqual([]);
    expect(harness.revoked).toBe(false);
});

/**
 * `panels` in the manifest, against a real workspace (Tynn #250).
 *
 * The unit suite proves the arithmetic against a fake workspace. What it cannot
 * reach is the half that only exists in a running Genie: a real `terminal_specs`
 * table, a real workspace row, and whether the SECOND open sees what the first one
 * wrote. That last one is the property the design turns on — a GApp's panels are
 * workspace state, not window state, so a seeder blind to its own past work would
 * hand somebody three more terminals every time they clicked the app's pill.
 */
test('a GApp gets the agent panels it declared — and no more on the next open', async () => {
    const outcome = await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_APPS__.seedAgentPanelsTwice(
            'com.genie.harness',
            { agents: 3, kinds: ['terminal', 'files'] },
        ),
    );

    // Three panels, cycling the declared palette: the count and the kinds are both
    // honoured, and a `files` kind becomes Genie's code panel.
    expect(outcome.first).toEqual(['Terminal', 'Files', 'Terminal']);
    // Opening it again changes nothing at all.
    expect(outcome.second).toEqual(['Terminal', 'Files', 'Terminal']);
});

/**
 * The DECLARED agents actually launching (genie#245).
 *
 * The bug this closes: a GApp could declare agents, ship personas, pass validation
 * and be named on the consent screen, and the seeder still wrote a bare terminal —
 * so the developer got N empty shells and no error. The unit suite proves the spec
 * is written with the binding; what only a running Genie can show is that the
 * binding survives the real database, the real workspace, and the real agent
 * terminal path — with a real pty behind it.
 *
 * Note what is asserted: not "three panels exist" (that passed on the broken
 * behaviour), but WHO each panel is and WHAT it was briefed with.
 */
test('a GApp’s declared agents are bound to their personas and launched', async () => {
    const outcome = await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_APPS__.seedAgentPanelsTwice(
            'com.genie.harness',
            { agents: 3, kinds: ['terminal', 'files'] },
            [
                { name: 'Strategist', persona: 'strategist.md' },
                { name: 'Reviewer', persona: 'reviewer/persona.md' },
            ],
        ),
    );

    // The panels are named after the agents, and the code panel between them is
    // NOT bound — an agent cannot run in the Files surface.
    expect(outcome.first).toEqual(['Strategist', 'Files', 'Reviewer']);
    expect(outcome.second).toEqual(['Strategist', 'Files', 'Reviewer']);

    expect(outcome.bindings[0]?.[0]).toBe('Strategist');
    expect(outcome.bindings[0]?.[1]).toContain('strategist.md');
    expect(outcome.bindings[1]).toBeNull();
    expect(outcome.bindings[2]?.[0]).toBe('Reviewer');
    expect(outcome.bindings[2]?.[1]).toContain('persona.md');

    // Under the WORKSTATION's provider — nothing in the manifest chose it.
    expect(outcome.providers[0]).toBe('claude');
    expect(outcome.providers[1]).toBeNull();
    expect(outcome.providers[2]).toBe('claude');
});

/**
 * THE PREVIEWER (Tynn #250).
 *
 * A GApp developer could scaffold a folder, check it, and install it — and had no
 * way to SEE the app in the window its users get without installing it first. This
 * opens a real GApp window over a folder that was never installed and asks the
 * three questions the previewer stands or falls on.
 *
 * The panels one is the headline, and it is the one a unit test cannot answer.
 * `preview-run.test.ts` proves the DECISION against fakes: a manifest declaring
 * three agent panels produces three `createPanel` calls. Between that decision and
 * three panels EXISTING sit the database, the workspace registry and the window —
 * and that gap is precisely where "the field is validated and nothing lays it out"
 * lived before any of this was built.
 */
test('a PREVIEW lays out the panels its manifest declared, without installing anything', async () => {
    const outcome = await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_APPS__.previewScaffolded({
            agents: 3,
            kinds: ['terminal', 'files'],
        }),
    );

    expect(outcome.errors).toEqual([]);
    expect(outcome.ok).toBe(true);

    // THE headline. Three real panels in a real workspace, cycling the declared
    // palette, for a folder nobody installed.
    expect(outcome.panels).toEqual(['Terminal', 'Files', 'Terminal']);

    // It runs as the PREVIEW identity, never as the app itself — the property that
    // stops a preview reading or corrupting an installed copy's storage, since the
    // partition is derived from this id.
    expect(outcome.appId).toBe('com.genie.previewed~preview');

    // And NOTHING was installed, while the window was open. Not the preview id,
    // not the app's own: no entry in the Apps list means no tray pill and nothing
    // to uninstall afterwards.
    expect(outcome.installedWhileOpen).not.toContain('com.genie.previewed');
    expect(outcome.installedWhileOpen).not.toContain('com.genie.previewed~preview');
});

test('the two-call bridge answers inside a preview, which has no grant row at all', async () => {
    /**
     * "Installs nothing" and "the bridge is live" pull against each other, and this
     * is where they meet. An installed app's `me()` and `call()` are answered from
     * a grant ROW; a preview deliberately has none and never will. So both lookups
     * had to learn about the live registry — the bridge, and the MCP caller
     * resolver that decides which workspace an allowed call lands in.
     *
     * Teaching one and not the other is the failure this test exists for, and it
     * is legible from neither file: `me()` answers happily while every `call()`
     * resolves to no workspace. An app that looks alive and can do nothing.
     */
    const outcome = await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_APPS__.previewScaffolded({ agents: 1 }),
    );

    const me = outcome.identity as {
        id: string;
        name: string;
        workspaceId: string;
        capabilities: string[];
        preview?: true;
    } | null;
    expect(me).not.toBeNull();

    // The app's REAL id, not the `~preview` one Genie keys its storage by. That is
    // what the app IS, and a developer whose code branches on its own id must not
    // silently take a different branch because Genie renamed it for bookkeeping.
    expect(me!.id).toBe('com.genie.previewed');

    // A real workspace — the preview's own. This is the half that fails silently
    // if only the bridge is taught and the caller resolver is not.
    expect(me!.workspaceId).toBeTruthy();
    expect(me!.workspaceId).toBe(outcome.workspaceId);

    // The scaffold asks for NOTHING, and the harness consents to exactly that. A
    // preview holding capabilities nobody granted would be the whole permission
    // model quietly not applying to the fast path.
    expect(me!.capabilities).toEqual([]);

    // And it is TOLD it is a preview, explicitly. An app that wanted to seed demo
    // data rather than touch anything real has to be able to ask, and sniffing its
    // own id for a suffix would make Genie's internal naming a public contract.
    expect(me!.preview).toBe(true);
});

test('closing a preview is the whole cleanup', async () => {
    // The other half of "it installs nothing": what it DID create has to go. The
    // throwaway workspace and every panel row in it — otherwise previewing ten
    // folders leaves ten dead workspaces holding terminals that were once live.
    const outcome = await app.evaluate(() =>
        (globalThis as Record<string, any>).__GENIE_E2E_APPS__.previewScaffolded({
            agents: 2,
        }),
    );

    expect(outcome.panels).toHaveLength(2);
    expect(outcome.afterClose.workspace).toBe(false);
    expect(outcome.afterClose.specs).toBe(0);
});
