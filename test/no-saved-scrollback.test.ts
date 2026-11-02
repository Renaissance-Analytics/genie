import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyWorkspace, terminalOpened } from '../src/core/workspace-view.js';
import { removeSavedScrollback } from '../src/main/saved-scrollback.js';

/**
 * SCROLLBACK IS NOT SAVED (the owner's decision 2, 2026-11-02: "stop saving it"; plan §13). A terminal's buffer is where people
 * paste tokens, and it was written in the clear to `terminal-snapshots.json` at every full quit. Now a terminal that was shut
 * down starts empty next time, and a terminal that survives in the host keeps its scrollback as it always did. An upgrade
 * deletes what an older Genie left: the plaintext file, and the in-window engine's `terminal-snapshots/` store, which has no
 * purpose left (its raw safeStorage cipher could fall back to plaintext gzip).
 */

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'no-scrollback-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('removeSavedScrollback: an upgrade deletes what an older Genie left', () => {
    it('the plaintext file and the engine’s store are GONE; nothing else is touched', async () => {
        const file = join(home, 'terminal-snapshots.json');
        const store = join(home, 'terminal-snapshots');
        const other = join(home, 'settings.json');
        writeFileSync(file, '{"ws":"export TOKEN=abc123"}');
        mkdirSync(store);
        writeFileSync(join(store, 'a-terminal.snap'), 'old');
        writeFileSync(other, '{}');
        // CONTROL: the gauge can see them there.
        expect([existsSync(file), existsSync(store)]).toEqual([true, true]);
        const log: string[] = [];
        await removeSavedScrollback(home, (line) => log.push(line));
        expect([existsSync(file), existsSync(store)]).toEqual([false, false]);
        expect(existsSync(other)).toBe(true);
        // Says so, once, so a run's log proves it; never a word of what was in it.
        expect(log.join('\n')).toMatch(/removed saved scrollback/);
        expect(log.join('\n')).not.toContain('abc123');
    });

    it('nothing to remove: quiet, and no failure', async () => {
        const log: string[] = [];
        await removeSavedScrollback(home, (line) => log.push(line));
        expect(log).toEqual([]);
    });
});

describe('a terminal that survives keeps its scrollback', () => {
    it('a live reattach opens with what it printed', () => {
        const live = terminalOpened(emptyWorkspace(), { id: 't1', workspaceId: 'ws', shell: 'bash', pid: 1, exited: null }, 'live scrollback\n');
        expect(live.output['t1']).toBe('live scrollback\n');
    });
});

describe('nothing writes or restores it any more', () => {
    const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
    const code = (f: string) => strip(readFileSync(f, 'utf8'));

    it('no source names the file, the restore, the divider or the engine’s store', () => {
        const found = files('src').filter((f) => /TerminalSnapshots|terminal-previous|previousSession|PREVIOUS_SESSION_DIVIDER|createSnapshotStore|SnapshotEncryptor/.test(code(f)));
        expect(found).toEqual([]);
        expect(existsSync('src/main/terminal-snapshots.ts')).toBe(false);
    });

    it('the engine persists nothing: its store is the no-op, in the window as in the spawn hosts', () => {
        expect(code('src/main/fancy-term-port.ts')).toMatch(/snapshots: NO_SNAPSHOTS/);
        expect(code('src/main/spawn-host.ts')).toMatch(/snapshots: NO_SNAPSHOTS/);
    });

    it('no raw safeStorage cipher is left in main.ts', () => {
        expect(code('src/main/main.ts')).not.toMatch(/safeStorage\.(encryptString|decryptString)/);
    });

    it('boot deletes what an older Genie left', () => {
        expect(code('src/main/main.ts')).toMatch(/await removeSavedScrollback\(genieHome\(\), lifecycleLog\);/);
    });

    it('a full quit records the running set and saves no screen', () => {
        expect(code('src/main/main.ts')).toMatch(/void recordShutdownNow\(\)\.catch\(/);
    });
});
