import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OUTPUT_CAP } from '../src/core/workspace-view.js';
import { TerminalSnapshots } from '../src/main/terminal-snapshots.js';

/**
 * TERMINAL SNAPSHOTS PERSISTED ON QUIT (§6.5). What a workspace's terminals showed when Genie closed is
 * saved — the LAST terminal's scrollback per workspace, capped from the front — and handed back ONCE on
 * the next launch, so the Workspace surface can seed its first terminal above the `— previous session —`
 * divider. Taken means gone: a reload never shows the same previous session twice. Empty is not saved.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-snapshots-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('TerminalSnapshots', () => {
    it('saves the last terminal per workspace, persists across a reopen, hands it back ONCE, skips empty, caps the tail', async () => {
        const s = await TerminalSnapshots.open(dir);
        expect(s.take('tynn')).toBeNull();
        await s.save([
            { workspaceId: 'tynn', scrollback: 'first terminal\r\n' },
            { workspaceId: 'tynn', scrollback: 'second terminal, the last opened\r\n' },
            { workspaceId: 'fancy', scrollback: '' },
            { workspaceId: 'prism', scrollback: 'x'.repeat(OUTPUT_CAP + 10) },
        ]);

        const again = await TerminalSnapshots.open(dir);
        expect(again.take('fancy')).toBeNull();
        expect(again.take('tynn')).toBe('second terminal, the last opened\r\n');
        expect(again.take('tynn')).toBeNull();
        expect(again.take('prism')!.length).toBe(OUTPUT_CAP);
        await again.flushed();

        const third = await TerminalSnapshots.open(dir);
        expect(third.take('tynn')).toBeNull();
        expect(third.take('prism')).toBeNull();
    });

    it('a new save replaces the old set wholesale — a workspace with no terminals at quit has nothing to restore', async () => {
        const s = await TerminalSnapshots.open(dir);
        await s.save([{ workspaceId: 'tynn', scrollback: 'old\r\n' }]);
        await s.save([{ workspaceId: 'moic', scrollback: 'new\r\n' }]);
        const again = await TerminalSnapshots.open(dir);
        expect(again.take('tynn')).toBeNull();
        expect(again.take('moic')).toBe('new\r\n');
    });
});
