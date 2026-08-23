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
