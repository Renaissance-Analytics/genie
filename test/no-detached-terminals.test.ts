import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quitPlan } from '../src/core/quit.js';
import { sectionOf } from '../src/core/settings-nav.js';
import { carryOverV1, SETTINGS } from '../src/core/settings.js';
import { engineSettingsFrom } from '../src/main/fancy-term-port.js';
import { SettingsStore } from '../src/main/settings-store.js';

/**
 * "KEEP TERMINALS THROUGH A QUIT" IS GONE (Tynn #416, the owner's ruling of 2026-11-04, audit P6 item 5). genie-host owns
 * the terminals and keeps them past a window's quit; the setting belonged to a window that held its own. Forward-only:
 * nothing migrates. A value stored by an older Genie is dropped, not honoured.
 */
describe('the setting', () => {
    it('is not offered, and has no place in Settings', () => {
        expect(SETTINGS.map((s) => s.key)).not.toContain('detached_terminals');
        expect(sectionOf('detached_terminals')).toBeNull();
    });

    it('Genie 1’s value does not carry over', () => {
        const { applied, dropped } = carryOverV1({ detached_terminals: 'on' });
        expect(applied).not.toHaveProperty('detached_terminals');
        expect(dropped.map((d) => d.key)).toContain('detached_terminals');
    });

    it('CONTROL: its neighbour stays', () => {
        expect(SETTINGS.map((s) => s.key)).toContain('track_cwd');
        expect(sectionOf('track_cwd')).toBe('terminals');
    });
});

describe('a value an older Genie stored', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-no-detached-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('does not break Settings, is not offered, and is gone from the file after the next write', async () => {
        await mkdir(join(dir, 'runtime'), { recursive: true });
        await writeFile(join(dir, 'runtime', 'settings.json'), JSON.stringify({ detached_terminals: true, track_cwd: false }));
        const store = await SettingsStore.open(dir);
        expect(store.snapshot()).not.toHaveProperty('detached_terminals');
        expect(store.snapshot().track_cwd).toBe(false);
        await store.set('track_cwd', true);
        expect(JSON.parse(await readFile(join(dir, 'runtime', 'settings.json'), 'utf8'))).not.toHaveProperty('detached_terminals');
    });
});

describe('the terminal engine and a quit', () => {
    it('the engine is always told terminals do not detach, whatever a stored value says', () => {
        expect(engineSettingsFrom(() => ({ detached_terminals: true })).get('detached_terminals')).toBe('off');
        expect(engineSettingsFrom(() => ({})).get('detached_terminals')).toBe('off');
        // CONTROL: the other setting it reads still comes from Genie's.
        expect(engineSettingsFrom(() => ({ track_cwd: true })).get('track_cwd')).toBe('on');
    });

    it('a quit with no genie-host counts the terminals as closing, always', () => {
        const stale = { runningAgents: [], liveTerminals: 2, detachedTerminals: true } as Parameters<typeof quitPlan>[0];
        expect(quitPlan(stale)).toMatchObject({ confirm: true, message: '2 terminals are open. Quitting closes the terminals.' });
    });

    it('nothing reads it any more', () => {
        for (const file of ['src/main/main.ts', 'src/core/quit.ts']) expect(readFileSync(file, 'utf8'), file).not.toMatch(/detached_?[tT]erminals/);
    });
});
