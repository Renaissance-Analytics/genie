import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesHost } from '../src/main/files-host.js';

/**
 * EDITING IN THE FILE PANEL (§4.3): you can type in a file an agent is editing, and NOTHING IS DISCARDED.
 * `open` now reports the sha of what was read; `write` lands only if the file on disk still has that sha —
 * otherwise it REFUSES with the conflict (what is on disk now, and its sha) and offers the choices; it never
 * overwrites a change it did not see. A write by you is attributed to `you` in the Changed groups.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let root: string;
let host: FilesHost;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-files-write-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'one\n');
    host = new FilesHost({ workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [] });
});
afterEach(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });

describe('FilesHost.write', () => {
    it('open reports the sha; a write with the matching sha lands and answers the new sha; the file is then yours in Changed', async () => {
        const opened = await host.open('tynn', 'src/a.ts');
        expect(opened).toMatchObject({ ok: true, text: 'one\n', sha: sha('one\n') });
        const r = await host.write('tynn', 'src/a.ts', 'one\ntwo\n', sha('one\n'));
        expect(r).toEqual({ ok: true, sha: sha('one\ntwo\n') });
        expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('one\ntwo\n');
        const state = await host.state('tynn');
        expect(state!.changed).toEqual([{ who: 'you', files: ['src/a.ts'] }]);
        expect(state!.unreported).toEqual([]);
    });

    it('a write whose sha no longer matches is REFUSED with the conflict — the disk\'s current text and sha — and nothing is overwritten', async () => {
        const opened = await host.open('tynn', 'src/a.ts') as { sha: string };
        await writeFile(join(root, 'src', 'a.ts'), 'one\nagent\n'); // an agent (or anyone) changed it underneath
        const r = await host.write('tynn', 'src/a.ts', 'one\nmine\n', opened.sha);
        expect(r).toEqual({ ok: false, conflict: { path: 'src/a.ts', onDisk: 'one\nagent\n', sha: sha('one\nagent\n') }, reason: 'src/a.ts changed on disk since you opened it; nothing was discarded — keep yours, take theirs, or merge' });
        expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('one\nagent\n');
        // Taking theirs is a re-open; keeping mine is a write with the CURRENT sha — an explicit choice, never implicit.
        expect(await host.write('tynn', 'src/a.ts', 'one\nmine\n', sha('one\nagent\n'))).toEqual({ ok: true, sha: sha('one\nmine\n') });
    });

    it('is confined to the workspace and refuses in words; a new file needs no sha', async () => {
        expect(await host.write('tynn', '../outside.ts', 'x', null)).toEqual({ ok: false, reason: 'that path is outside the workspace; Genie writes nothing there' });
        expect(await host.write('tynn', 'src/new.ts', 'fresh\n', null)).toEqual({ ok: true, sha: sha('fresh\n') });
        expect(await readFile(join(root, 'src', 'new.ts'), 'utf8')).toBe('fresh\n');
        expect(await host.write('nope', 'src/a.ts', 'x', null)).toEqual({ ok: false, reason: 'no such workspace' });
    });
});
