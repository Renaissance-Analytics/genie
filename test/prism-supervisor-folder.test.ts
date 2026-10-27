import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeStaleSupervisorBuilds, supervisorFolder } from '../src/main/prism-supervisor.js';

/**
 * GENIE'S SUPERVISOR FOLDER IS KEYED BY THE SUPERVISOR'S SOURCE (genie#1259).
 *
 * Genie used to hand prism-acp one fixed folder, `<runtime>/prism-supervisor`. prism-acp only checks a build against the
 * hash recorded FOR THAT BUILD, so a supervisor an older prism-acp built there kept passing after an upgrade: on
 * genie-test-windows a 0.29 build stayed in use under 0.31 and, having no approval mode, exited 125 as the approval adapter
 * of every Claude shell call. prism-acp's own default folder is keyed by its source; Genie's now is too, the same way, and
 * a build from any other source is never reused. What other sources left behind is removed — Genie's own folder only, and
 * never what a running process was started from. The Windows half (real builds, a real running image) is in
 * supervisor-cold-start-windows.test.ts.
 */

let runtime: string;
beforeEach(async () => { runtime = await mkdtemp(join(tmpdir(), 'genie-supervisor-folder-')); });
afterEach(async () => { await rm(runtime, { recursive: true, force: true }); });

describe('the folder', () => {
    it('is keyed by the supervisor source: another source is another folder, the same source the same one', () => {
        const current = supervisorFolder(runtime);
        expect(dirname(current)).toBe(join(runtime, 'prism-supervisor'));
        expect(basename(current)).toMatch(/^supervisor-[0-9a-f]{16}$/);
        expect(supervisorFolder(runtime, 'class Older {}')).not.toBe(supervisorFolder(runtime, 'class Newer {}'));
        expect(supervisorFolder(runtime, 'class Same {}')).toBe(supervisorFolder(runtime, 'class Same {}'));
        // The default is the source prism-acp builds from, not some other text.
        expect(supervisorFolder(runtime, 'class Older {}')).not.toBe(current);
    });
});

/** What earlier Genies left in `<runtime>/prism-supervisor`: the flat ≤0.31 build, the 0.32 pointer layout, another key. */
async function leftovers(): Promise<{ parent: string; current: string; otherKey: string }> {
    const parent = join(runtime, 'prism-supervisor');
    const current = supervisorFolder(runtime);
    const otherKey = join(parent, 'supervisor-0123456789abcdef');
    await mkdir(current, { recursive: true });
    await mkdir(otherKey, { recursive: true });
    await writeFile(join(parent, 'prism-acp-supervisor.exe'), 'old');
    await writeFile(join(parent, 'prism-acp-supervisor.exe.sha256'), 'a'.repeat(64));
    await writeFile(join(parent, `prism-acp-supervisor-${'b'.repeat(64)}.exe`), 'old');
    await writeFile(join(parent, 'prism-acp-supervisor.current.sha256'), 'b'.repeat(64));
    await writeFile(join(otherKey, `prism-acp-supervisor-${'c'.repeat(64)}.exe`), 'old');
    await writeFile(join(otherKey, 'prism-acp-supervisor.current.sha256'), 'c'.repeat(64));
    await writeFile(join(current, `prism-acp-supervisor-${'d'.repeat(64)}.exe`), 'current');
    await writeFile(join(current, 'prism-acp-supervisor.current.sha256'), 'd'.repeat(64));
    return { parent, current, otherKey };
}

describe('stale builds', () => {
    it('everything in Genie’s supervisor folder but the current key is removed; the current build is untouched', async () => {
        const { parent, current } = await leftovers();
        const sweep = await removeStaleSupervisorBuilds(runtime, { current, runningImages: async () => [] });
        expect(await readdir(parent)).toEqual([basename(current)]);
        expect((await readdir(current)).sort()).toEqual([`prism-acp-supervisor-${'d'.repeat(64)}.exe`, 'prism-acp-supervisor.current.sha256']);
        expect(sweep).toMatchObject({ running: [], failed: [], unread: false });
        expect(sweep.removed).toHaveLength(5);
    });

    it('an entry a running process was started from is kept, and said; the rest still go', async () => {
        const { parent, current, otherKey } = await leftovers();
        const runningExe = join(otherKey, `prism-acp-supervisor-${'c'.repeat(64)}.exe`);
        const legacy = join(parent, 'prism-acp-supervisor.exe');
        // Windows paths compare without case: the listing may spell the folder differently than Genie does.
        const listed = process.platform === 'win32' ? [runningExe.toUpperCase(), legacy] : [runningExe, legacy];
        const sweep = await removeStaleSupervisorBuilds(runtime, { current, runningImages: async () => listed });
        expect(existsSync(runningExe)).toBe(true);
        expect(existsSync(legacy)).toBe(true);
        expect([...sweep.running].sort()).toEqual([legacy, otherKey].sort());
        expect((await readdir(parent)).sort()).toEqual([basename(current), basename(otherKey), 'prism-acp-supervisor.exe'].sort());
    });

    it('a process listing that could not be read removes NOTHING — never read as "nothing is running"', async () => {
        const { parent, current } = await leftovers();
        const before = (await readdir(parent)).sort();
        const sweep = await removeStaleSupervisorBuilds(runtime, { current, runningImages: async () => null });
        expect(sweep).toEqual({ removed: [], running: [], failed: [], unread: true });
        expect((await readdir(parent)).sort()).toEqual(before);
        // The positive control: the same tree, read, is swept.
        expect((await removeStaleSupervisorBuilds(runtime, { current, runningImages: async () => [] })).removed).toHaveLength(5);
    });

    it('nothing stale (or no folder at all): no process listing is taken', async () => {
        const read = vi.fn(async () => []);
        expect(await removeStaleSupervisorBuilds(runtime, { current: supervisorFolder(runtime), runningImages: read })).toEqual({ removed: [], running: [], failed: [], unread: false });
        await mkdir(supervisorFolder(runtime), { recursive: true });
        expect(await removeStaleSupervisorBuilds(runtime, { current: supervisorFolder(runtime), runningImages: read })).toEqual({ removed: [], running: [], failed: [], unread: false });
        expect(read).not.toHaveBeenCalled();
    });

    it('a current folder outside Genie’s supervisor folder is refused, so a wrong argument cannot empty the parent', async () => {
        await leftovers();
        await expect(removeStaleSupervisorBuilds(runtime, { current: join(runtime, 'elsewhere'), runningImages: async () => [] })).rejects.toThrow(/not in/);
        expect(await readdir(join(runtime, 'prism-supervisor'))).toHaveLength(6);
    });
});
