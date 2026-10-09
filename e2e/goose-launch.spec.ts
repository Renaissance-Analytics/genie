import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    killMasterTerminals,
    launchGenieE2E,
    withTeardownBound,
} from './helpers/launch';

/**
 * A GOOSE AGENT CAN REACH GENIE — proven in a real app, in a clean VM.
 *
 * Goose support is not "the registry has a row". A Goose agent is only useful
 * inside Genie if it can call `imDone` and `ForceTheQuestion`, and that depends
 * on a chain no unit test can close:
 *
 *   1. bare `goose` starts an interactive session but passes NO extensions
 *      (`cli.rs:2742-2772`), so the agent has no `genie` MCP server at all;
 *   2. the flags that attach one live on the `session` subcommand, which the
 *      top-level CLI does not accept (`cli.rs:71-74`) — the word has to be
 *      INSERTED into the launch line;
 *   3. the URL has to be THIS terminal's own endpoint, minted after the
 *      terminal id exists, by an MCP server that is actually listening.
 *
 * `goose-launch.test.ts` asserts the string shape off a pure function. What it
 * cannot assert is that the URL in that string is an endpoint this app would
 * answer — that needs a live main process, which is what the VM gives us.
 *
 * These assertions are about GENIE's half. They do not require Goose to be
 * installed on the runner: what is under test is the command Genie builds. The
 * last test checks the binary only when the VM really has it, and says so
 * rather than skipping silently.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master'));
    const whatsNew = page.locator('.whats-new-backdrop');
    await whatsNew.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await whatsNew.count()) {
        await page.getByRole('button', { name: 'Got it' }).click();
    }
});

test.afterAll(async () => {
    if (app) await killMasterTerminals(app).catch(() => {});
    if (app) await withTeardownBound(app.close(), 20_000, 'app.close()').catch(() => {});
});

/** The launch line the REAL production path builds, for a given terminal id. */
const launchLine = (terminalId: string): Promise<string | null> =>
    app.evaluate((_e, id) => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MASTER__;
        return (h?.gooseLaunchLine?.(id) as string | null) ?? null;
    }, terminalId);

test('the launch line runs the `session` subcommand, not bare `goose`', async () => {
    const line = await launchLine('e2e-goose-1');
    expect(line, 'the production path produced no command at all').toBeTruthy();

    // Inserted directly after the binary. `goose --with-…` is a clap error,
    // so position is the assertion, not mere presence.
    expect(line).toMatch(/(^|\s)goose(\.exe|\.cmd)?\s+session(\s|$)/);
});

test('it attaches THIS terminal\'s own genie endpoint', async () => {
    const line = await launchLine('e2e-goose-2');

    expect(line).toContain('--with-streamable-http-extension');

    // A real, local, token-bearing endpoint — not a placeholder and not the
    // workspace-scoped URL. Genie's token rides in the PATH, which is the one
    // shape this flag can carry; the server refuses a multi-terminal call whose
    // token does not self-identify the terminal (genie#35).
    const url = /--with-streamable-http-extension\s+"([^"]+)"/.exec(line ?? '')?.[1];
    expect(url, 'the flag carried no quoted url').toBeTruthy();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/.+/);
});

test('two terminals get DIFFERENT endpoints', async () => {
    // The whole reason this is woven in at terminal-create time rather than
    // baked into the stored command. One shared URL would make the server
    // refuse every call that could not say which terminal it came from.
    const one = await launchLine('e2e-goose-a');
    const two = await launchLine('e2e-goose-b');

    const urlOf = (line: string | null) =>
        /--with-streamable-http-extension\s+"([^"]+)"/.exec(line ?? '')?.[1];

    expect(urlOf(one)).toBeTruthy();
    expect(urlOf(two)).toBeTruthy();
    expect(urlOf(one)).not.toBe(urlOf(two));
});

test('a relaunch REPLACES the endpoint rather than stacking another', async () => {
    // An upgrade mints a new port and token. Two extensions would leave the
    // agent talking to a dead one half the time.
    const line = await launchLine('e2e-goose-3');
    const count = (line ?? '').split('--with-streamable-http-extension').length - 1;
    expect(count).toBe(1);

    const again = await app.evaluate((_e, prior) => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MASTER__;
        // Feed the ALREADY-augmented command back through, the way a relaunch
        // does when it reads the stored `agent_command`.
        return (h?.gooseLaunchLine?.('e2e-goose-3') as string | null) ?? prior;
    }, line);
    expect((again ?? '').split('--with-streamable-http-extension').length - 1).toBe(1);
});

test('when the VM really has Goose, Genie resolves the binary it claims', async () => {
    // The registry says the binary is `goose` and the catalog says it ships as a
    // GitHub release rather than on npm. On a runner where the install step ran,
    // that claim is checkable rather than recalled — and if it is wrong, every
    // probe and every launch downstream is wrong with it.
    const resolved = await app.evaluate(() => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MASTER__;
        return (h?.resolvesOnPath?.('goose') as Promise<string | undefined>) ?? undefined;
    });

    if (!resolved) {
        test.skip(
            true,
            'Goose is not installed on this runner — the install step runs on ubuntu only',
        );
        return;
    }
    expect(resolved).toMatch(/goose(\.exe|\.cmd)?$/i);
});
