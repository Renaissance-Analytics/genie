// @vitest-environment happy-dom
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appVersion, closeWhatsNew, seedWhatsNewSeen, WHATS_NEW_SEEN } from '../scripts/cdp-whats-new.mjs';
import { whatsNewFor } from '../src/core/whats-new.js';

/*
 * WHAT'S NEW NEVER COVERS A ROW'S CLICK (Tynn #1009). Gate 1121-054848-5be253 lost windows/sound-picker at PR #2125's head:
 * the row's fresh home had no `whats_new_seen_version`, the dialog opened late over Settings, and the mouse at the
 * Notifications nav reached its backdrop. The seed records the running version as seen; the close helper takes one off
 * the page by its Close button if it is there anyway.
 */
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'genie-whats-new-1009-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); document.body.innerHTML = ''; });

describe('the seed', () => {
    it('records package.json\'s version as seen, so the host decides there is nothing to show', () => {
        const genie = tmp();
        const file = seedWhatsNewSeen(genie);
        expect(file).toBe(join(genie, 'runtime', 'settings.json'));
        const seen = JSON.parse(readFileSync(file, 'utf8'))[WHATS_NEW_SEEN];
        const version = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
        expect(seen).toBe(version);
        expect(appVersion()).toBe(version);
        // The host's own rule, fed what the seed wrote: nothing is shown for the running version (and, as a control, an
        // unseeded home WOULD show it).
        const notes = { [version]: '## What\'s new\n\n- a thing\n' };
        expect(whatsNewFor(version, seen, notes, false)).toBeNull();
        expect(whatsNewFor(version, '', notes, false)).not.toBeNull();
    });

    it('keeps the settings already in the file', () => {
        const genie = tmp();
        mkdirSync(join(genie, 'runtime'), { recursive: true });
        writeFileSync(join(genie, 'runtime', 'settings.json'), JSON.stringify({ remote_access: true, theme: 'dark' }));
        seedWhatsNewSeen(genie, '9.9.9');
        expect(JSON.parse(readFileSync(join(genie, 'runtime', 'settings.json'), 'utf8'))).toEqual({ remote_access: true, theme: 'dark', [WHATS_NEW_SEEN]: '9.9.9' });
    });

    it('refuses a settings file that is not JSON rather than dropping what was in it', () => {
        const genie = tmp();
        mkdirSync(join(genie, 'runtime'), { recursive: true });
        writeFileSync(join(genie, 'runtime', 'settings.json'), '{ not json');
        expect(() => seedWhatsNewSeen(genie, '9.9.9')).toThrow();
        expect(readFileSync(join(genie, 'runtime', 'settings.json'), 'utf8')).toBe('{ not json');
    });
});

/** The page as Genie draws it (WhatsNewWindow.tsx): the dialog, its backdrop, its body and its Close button. */
function openWhatsNew(version: string, closesAfterMs = 0) {
    document.body.innerHTML = `<div data-modal><div class="absolute inset-0" aria-hidden="true"></div><div role="dialog">
        <div data-whats-new="${version}"><button data-action="whats-new-close">Close</button></div></div></div>
        <button data-settings-nav="notifications">Notifications</button>`;
    const button = document.querySelector('[data-action="whats-new-close"]') as HTMLButtonElement;
    let pressed = 0;
    button.addEventListener('click', () => { pressed++; setTimeout(() => document.querySelector('[data-modal]')?.remove(), closesAfterMs); });
    return { pressed: () => pressed };
}
// The page expression runs in this document, as CDP's Runtime.evaluate runs it in the window.
const evaluate = async (expression: string) => (0, eval)(expression);

describe('the close helper', () => {
    it('closes an open What\'s new by its Close button, waits until it has gone, and logs that it did', async () => {
        const page = openWhatsNew('2.0.0-beta.62.1', 250);
        const lines: string[] = [];
        const r = await closeWhatsNew(evaluate, { log: (l: string) => lines.push(l), pollMs: 20 });
        expect(r).toEqual({ closed: true, version: '2.0.0-beta.62.1' });
        expect(page.pressed()).toBe(1);
        expect(document.querySelector('[data-whats-new]')).toBeNull();
        expect(document.querySelector('[data-settings-nav="notifications"]')).not.toBeNull();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('What\'s new 2.0.0-beta.62.1');
        expect(lines[0]).toContain('Close button');
    });

    it('does nothing and says nothing when none is open', async () => {
        document.body.innerHTML = '<button data-settings-nav="notifications">Notifications</button>';
        const lines: string[] = [];
        expect(await closeWhatsNew(evaluate, { log: (l: string) => lines.push(l) })).toEqual({ closed: false });
        expect(lines).toEqual([]);
    });

    it('throws when it will not close, so a row never clicks on through it', async () => {
        openWhatsNew('2.0.0', 60_000);
        await expect(closeWhatsNew(evaluate, { log: () => {}, timeoutMs: 200, pollMs: 20 })).rejects.toThrow(/did not close/);
    });
});

/** Source without its comments, line by line (a comment naming the helper is not a use of it). */
const code = (file: string) => readFileSync(join(__dirname, '..', 'scripts', file), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('every row that clicks uses them', () => {
    const clickers = readdirSync(join(__dirname, '..', 'scripts')).filter((f) => f.endsWith('-cdp.mjs'))
        .filter((f) => /\.click\(\)|mousePressed/.test(code(f)));

    it('finds the rows that click (a control: the sweep is not empty)', () => {
        expect(clickers).toEqual(expect.arrayContaining(['sound-picker-cdp.mjs', 'accounts-popover-cdp.mjs', 'smoke-cdp.mjs', 'ui-lag-cdp.mjs']));
    });

    it('each one closes What\'s new with the shared helper before it clicks', () => {
        const without = clickers.filter((f) => !/from '\.\/cdp-whats-new\.mjs'/.test(code(f)) || !/closeWhatsNew\(/.test(code(f)));
        expect(without).toEqual([]);
    });

    it('the homes those rows start on are seeded as seen (ui-lag excepted: it measures the dialog itself)', () => {
        // Their own fresh homes; smoke-seed is the CI app home's seed, and gapp-open, local-door and the rest run it.
        for (const f of ['sound-picker-cdp.mjs', 'accounts-popover-cdp.mjs', 'trust-step-cdp.mjs', 'crash-cdp-lib.mjs', 'smoke-seed.mjs']) {
            expect(code(f), f).toMatch(/seedWhatsNewSeen\(/);
        }
        for (const f of ['gapp-open-cdp.mjs', 'local-door-cdp.mjs']) expect(code(f), f).toMatch(/smoke-seed\.mjs/);
        expect(code('smoke-seed.mjs')).toMatch(/GENIE_SEED_WHATS_NEW !== 'unseen'\) seedWhatsNewSeen\(/);
        expect(code('ui-lag-cdp.mjs')).not.toMatch(/seedWhatsNewSeen\(/);
        expect(code('ui-lag-cdp.mjs')).toMatch(/GENIE_SEED_WHATS_NEW: 'unseen'/);
    });

    it('smoke-seed, run as CI runs it, writes the setting (and leaves it unwritten when asked to)', () => {
        for (const [mode, expected] of [['', appVersion()], ['unseen', undefined]] as const) {
            const home = tmp();
            const r = spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'smoke-seed.mjs')], {
                cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, GENIE_HOME: join(home, '.genie'), GENIE_SEED_WHATS_NEW: mode }, encoding: 'utf8',
            });
            expect(r.status, r.stderr).toBe(0);
            let settings: Record<string, unknown> = {};
            try { settings = JSON.parse(readFileSync(join(home, '.genie', 'runtime', 'settings.json'), 'utf8')); } catch { /* none written */ }
            expect(settings[WHATS_NEW_SEEN], mode || 'default').toBe(expected);
        }
    });
});
