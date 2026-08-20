import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
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
let appWindow: Page;

test.beforeAll(async () => {
    ({ app } = await launchGenieE2E());

    // The window must be awaited BEFORE the open, or the event is missed.
    const [opened] = await Promise.all([
        app.waitForEvent('window'),
        app.evaluate(() =>
            (globalThis as Record<string, any>).__GENIE_E2E_APPS__.openExample(),
        ),
    ]);
    appWindow = opened;
    await appWindow.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
    await app?.close();
});

test('the page renders the app’s own front end', async () => {
    // Proves the window really loaded the served app rather than sitting blank —
    // without which every assertion below would pass vacuously on an empty page.
    await expect(appWindow.locator('h1')).toContainText('Genie App Example');
});

test('window.genie is ABSENT — the property the whole model rests on', async () => {
    const seen = await appWindow.evaluate(() => ({
        genie: typeof (window as unknown as Record<string, unknown>).genie,
        require: typeof (window as unknown as Record<string, unknown>).require,
        process: typeof (window as unknown as Record<string, unknown>).process,
        module: typeof (window as unknown as Record<string, unknown>).module,
    }));

    expect(seen.genie).toBe('undefined');
    // And no Node, by any of the usual doors.
    expect(seen.require).toBe('undefined');
    expect(seen.process).toBe('undefined');
    expect(seen.module).toBe('undefined');
});

test('window.genieApp is exactly two calls, and no more', async () => {
    // The surface is meant to be small. A third method appearing here without a
    // deliberate decision is the kind of drift that ends in a wide bridge.
    const keys = await appWindow.evaluate(() =>
        Object.keys((window as unknown as Record<string, any>).genieApp ?? {}).sort(),
    );
    expect(keys).toEqual(['call', 'me']);
});

test('the app learns who it is — from Genie, not from itself', async () => {
    const me = await appWindow.evaluate(() => (window as unknown as Record<string, any>).genieApp.me());

    expect(me).toMatchObject({ id: 'com.genie.example', name: 'Genie App Example' });
    // The GRANTED set, not the declared one: the harness declares hosting AND
    // terminals and grants only hosting.
    expect(me.capabilities).toEqual(['hosting']);
});

test('an ungranted call is refused, in words the user could act on', async () => {
    const outcome = await appWindow.evaluate(() =>
        (window as unknown as Record<string, any>).genieApp.call('manageTerminals', { action: 'list' }),
    );

    expect(outcome.ok).toBe(false);
    // Named by its human label, not its tool id — this string is shown to a person.
    expect(outcome.error).toContain('Run commands');
    expect(outcome.error).toContain('Genie App Example');
});

test('a tool no app may ever use is refused with the standing reason', async () => {
    // `submitFeedback` posts to Tynn in the user's name. There is no permission
    // level at which an app gets it, so the message must not suggest a setting.
    const outcome = await appWindow.evaluate(() =>
        (window as unknown as Record<string, any>).genieApp.call('submitFeedback', { text: 'hi' }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/impersonat/i);
});

test('a granted call reaches the real tool', async () => {
    // It may well fail INSIDE the tool — the harness grant points at a workspace
    // that does not exist — but it must get past the gate. A refusal here would
    // mean the granted path never opens, which no negative test can catch.
    const outcome = await appWindow.evaluate(() =>
        (window as unknown as Record<string, any>).genieApp.call('manageSite', { action: 'list' }),
    );

    expect(String(outcome.error ?? '')).not.toContain('was not granted');
});

test('the page cannot claim to be a different app', async () => {
    // There is no field for it — identity is the window Genie recorded. Sending
    // one anyway must change nothing.
    const me = await appWindow.evaluate(async () => {
        const genieApp = (window as unknown as Record<string, any>).genieApp;
        await genieApp.call('manageSite', { action: 'list', appId: 'com.attacker.app' });
        return genieApp.me();
    });

    expect(me.id).toBe('com.genie.example');
});
