import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { startRefusal } from '../src/main/workspace-ops-host.js';

/**
 * A WORKSPACE WHOSE FOLDER IS GONE IS FLAGGED MISSING, NEVER DROPPED (host split P7, build spec item 3; ruling R1,
 * 2026-11-23). Before this, a workspace whose recorded folder no longer existed was kept with no flag and no check.
 *
 * - The look: gone = missing; a file at the path = missing; "could not look" (no permission, a disk error) is NOT
 *   missing; a hibernated workspace is never looked at and never flagged.
 * - A folder that comes back by itself clears the flag on the timed look, with no action.
 * - The look is repeated every 10 s while any workspace is missing and every 60 s otherwise.
 * - Nothing is written by the look, and the workspace stays in every list: its snapshot row carries `missing: true`.
 * - Its agents are not started, said in words (`startRefusal`).
 *
 * Every absence claim has a positive control beside it. Fixtures name no person.
 */

interface Listed { id: string; path: string; asleep?: boolean }
interface MissingPorts {
    workspaces(): readonly Listed[];
    isDirectory(path: string): Promise<boolean>;
    schedule(ms: number, fn: () => void): () => void;
    log?(line: string): void;
}
interface MissingWorkspacesLike {
    check(): Promise<void>;
    isMissing(id: string): boolean;
    pathIfMissing(id: string): string | null;
    onChange(listener: () => void): () => void;
    start(): Promise<void>;
    stop(): void;
}
interface MissingModule {
    MISSING_RECHECK_MS: number;
    PRESENT_RECHECK_MS: number;
    MissingWorkspaces: new (ports: MissingPorts) => MissingWorkspacesLike;
    nodeIsDirectory(path: string): Promise<boolean>;
}
async function missingModule(): Promise<MissingModule> { const path: string = '../src/main/missing-workspaces.js'; return import(path) as Promise<MissingModule>; }

const roots: string[] = [];
const tempRoot = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const errno = (code: string): Error => Object.assign(new Error(`${code}: fixture`), { code });

/** The module over fakes: `there` says which paths hold a directory; time is the test's. */
async function rig(workspaces: Listed[], look: (path: string) => Promise<boolean>) {
    const { MissingWorkspaces } = await missingModule();
    const pending: { ms: number; fn: () => void }[] = [];
    const looked: string[] = [];
    const used = new Set<string>();
    const ports: MissingPorts = {
        workspaces: () => workspaces,
        isDirectory: (path) => { looked.push(path); return look(path); },
        schedule: (ms, fn) => {
            const timer = { ms, fn };
            pending.push(timer);
            return () => { const at = pending.indexOf(timer); if (at >= 0) pending.splice(at, 1); };
        },
        log: () => {},
    };
    // Every port the module reaches for is recorded: it has no write port, and must ask for none.
    const watched = new Proxy(ports, { get: (target, key) => { used.add(String(key)); return Reflect.get(target, key) as unknown; } });
    const missing = new MissingWorkspaces(watched);
    let changes = 0;
    missing.onChange(() => { changes++; });
    /** The timed look: the one pending timer fires, and its pass is waited for. */
    const fire = async () => {
        expect(pending).toHaveLength(1);
        const [timer] = pending.splice(0, 1);
        timer!.fn();
        await missing.check();
    };
    return { missing, pending, looked, used, fire, changes: () => changes };
}

const only = (present: readonly string[]) => async (path: string) => present.includes(path);

describe('the look: which workspaces are missing', () => {
    it('a folder that is gone is missing, with its recorded path; one that is there is not (the control)', async () => {
        const r = await rig([{ id: 'gone', path: '/w/gone' }, { id: 'here', path: '/w/here' }], only(['/w/here']));
        // Before any look nothing is claimed.
        expect(r.missing.isMissing('gone')).toBe(false);
        await r.missing.check();
        expect(r.missing.isMissing('gone')).toBe(true);
        expect(r.missing.pathIfMissing('gone')).toBe('/w/gone');
        expect(r.missing.isMissing('here')).toBe(false);
        expect(r.missing.pathIfMissing('here')).toBeNull();
        expect(r.looked.sort()).toEqual(['/w/gone', '/w/here']);
    });

    it('the real look: a directory is there; nothing, a file, and a path through a file are not', async () => {
        const { nodeIsDirectory } = await missingModule();
        const root = tempRoot('genie-p7-missing-look-');
        const folder = join(root, 'folder'); const file = join(root, 'file.txt');
        mkdirSync(folder); writeFileSync(file, 'x');
        expect(await nodeIsDirectory(folder)).toBe(true);
        expect(await nodeIsDirectory(join(root, 'nothing'))).toBe(false);
        expect(await nodeIsDirectory(file)).toBe(false);
        expect(await nodeIsDirectory(join(file, 'under-a-file'))).toBe(false);
    });

    it('the real look that FAILS is a rejection, never "not there": a path the OS will not take (a NUL in it) is neither there nor gone', async () => {
        // Written after the look (a break probe that called every failure "gone" passed every other row): it goes red on that probe.
        const { nodeIsDirectory } = await missingModule();
        const root = tempRoot('genie-p7-look-fails-');
        await expect(nodeIsDirectory(join(root, `bad${String.fromCharCode(0)}name`))).rejects.toThrow();
        // CONTROL: beside it, nothing there is still a plain false.
        expect(await nodeIsDirectory(join(root, 'nothing'))).toBe(false);
    });

    it('a FILE at the recorded path is missing (on the real disk); the folder beside it is not', async () => {
        const { MissingWorkspaces, nodeIsDirectory } = await missingModule();
        const root = tempRoot('genie-p7-missing-file-');
        const file = join(root, 'was-a-folder'); const folder = join(root, 'folder');
        writeFileSync(file, 'x'); mkdirSync(folder);
        const missing = new MissingWorkspaces({ workspaces: () => [{ id: 'file', path: file }, { id: 'folder', path: folder }], isDirectory: nodeIsDirectory, schedule: () => () => {} });
        await missing.check();
        expect(missing.isMissing('file')).toBe(true);
        expect(missing.isMissing('folder')).toBe(false);
    });

    it.each(['EACCES', 'EPERM', 'EIO'])('"could not look" (%s) is NOT "it is gone"; the same workspace with nothing there IS missing (the control)', async (code) => {
        const refused = await rig([{ id: 'locked', path: '/w/locked' }], async () => { throw errno(code); });
        await refused.missing.check();
        expect(refused.looked).toEqual(['/w/locked']);
        expect(refused.missing.isMissing('locked')).toBe(false);
        expect(refused.changes()).toBe(0);

        const gone = await rig([{ id: 'locked', path: '/w/locked' }], only([]));
        await gone.missing.check();
        expect(gone.missing.isMissing('locked')).toBe(true);
    });

    it('a look that fails leaves what was known standing: a missing workspace stays missing, with no change announced', async () => {
        let fail = false;
        const r = await rig([{ id: 'gone', path: '/w/gone' }], async () => { if (fail) throw errno('EIO'); return false; });
        await r.missing.check();
        expect(r.missing.isMissing('gone')).toBe(true);
        expect(r.changes()).toBe(1);
        fail = true;
        await r.missing.check();
        expect(r.missing.isMissing('gone')).toBe(true);
        expect(r.changes()).toBe(1);
    });

    it('a hibernated workspace is never looked at and never flagged; an awake one with the same fate is both (the control)', async () => {
        const r = await rig([{ id: 'asleep', path: '/w/asleep', asleep: true }, { id: 'awake', path: '/w/awake' }], only([]));
        await r.missing.check();
        expect(r.looked).toEqual(['/w/awake']);
        expect(r.looked).not.toContain('/w/asleep');
        expect(r.missing.isMissing('asleep')).toBe(false);
        expect(r.missing.pathIfMissing('asleep')).toBeNull();
        expect(r.missing.isMissing('awake')).toBe(true);
    });

    it('a workspace that goes to sleep while missing loses the flag, and is not looked at again', async () => {
        const list: Listed[] = [{ id: 'w', path: '/w/w' }];
        const r = await rig(list, only([]));
        await r.missing.check();
        expect(r.missing.isMissing('w')).toBe(true);
        list[0] = { id: 'w', path: '/w/w', asleep: true };
        r.looked.length = 0;
        await r.missing.check();
        expect(r.looked).toEqual([]);
        expect(r.missing.isMissing('w')).toBe(false);
    });

    it('a workspace located somewhere else is looked at where it is now', async () => {
        const list: Listed[] = [{ id: 'w', path: '/w/old' }];
        const r = await rig(list, only(['/w/new']));
        await r.missing.check();
        expect(r.missing.pathIfMissing('w')).toBe('/w/old');
        list[0] = { id: 'w', path: '/w/new' };
        await r.missing.check();
        expect(r.missing.isMissing('w')).toBe(false);
        expect(r.changes()).toBe(2);
    });

    it('one pass at a time: asks made during a pass never look at a folder twice at once', async () => {
        let inFlight = 0; let most = 0; let passes = 0;
        const release: (() => void)[] = [];
        const r = await rig([{ id: 'w', path: '/w/w' }], () => new Promise<boolean>((resolve) => {
            passes++; inFlight++; most = Math.max(most, inFlight);
            release.push(() => { inFlight--; resolve(false); });
        }));
        const asked = [r.missing.check(), r.missing.check(), r.missing.check()];
        // Let the first pass begin, then ask again while it is looking.
        await new Promise<void>((resolve) => setImmediate(resolve));
        asked.push(r.missing.check());
        for (let i = 0; i < 10 && (release.length > 0 || inFlight > 0 || i < 3); i++) {
            for (const go of release.splice(0)) go();
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await Promise.all(asked);
        expect(most).toBe(1);
        // The asks before the first pass began are one pass; the ask made during it is one more.
        expect(passes).toBe(2);
        expect(r.missing.isMissing('w')).toBe(true);
    });
});

describe('a folder that comes back by itself clears the flag with no action', () => {
    it('on the timed look, on the real disk; onChange fires exactly once per change', async () => {
        const { MissingWorkspaces, nodeIsDirectory } = await missingModule();
        const root = tempRoot('genie-p7-missing-back-');
        const drive = join(root, 'drive', 'workspace');
        const pending: (() => void)[] = [];
        const missing = new MissingWorkspaces({
            workspaces: () => [{ id: 'w', path: drive }],
            isDirectory: nodeIsDirectory,
            schedule: (_ms, fn) => { pending.push(fn); return () => { const at = pending.indexOf(fn); if (at >= 0) pending.splice(at, 1); }; },
        });
        let changes = 0;
        missing.onChange(() => { changes++; });
        const timedLook = async () => { expect(pending).toHaveLength(1); pending.splice(0, 1)[0]!(); await missing.check(); };

        await missing.start();
        expect(missing.isMissing('w')).toBe(true);
        expect(changes).toBe(1);

        // Still gone at the next timed look: no change is announced.
        await timedLook();
        expect(missing.isMissing('w')).toBe(true);
        expect(changes).toBe(1);

        // The drive is mounted again. Nobody does anything in Genie.
        mkdirSync(drive, { recursive: true });
        expect(missing.isMissing('w')).toBe(true);
        await timedLook();
        expect(missing.isMissing('w')).toBe(false);
        expect(missing.pathIfMissing('w')).toBeNull();
        expect(changes).toBe(2);

        // And it stays quiet while nothing changes.
        await timedLook();
        expect(changes).toBe(2);

        // Gone again: flagged again, once.
        rmSync(drive, { recursive: true, force: true });
        await timedLook();
        expect(missing.isMissing('w')).toBe(true);
        expect(changes).toBe(3);
        missing.stop();
    });

    it('a listener that stopped listening hears nothing more', async () => {
        const present: string[] = [];
        const r = await rig([{ id: 'w', path: '/w/w' }], (path) => only(present)(path));
        let heard = 0;
        const off = r.missing.onChange(() => { heard++; });
        await r.missing.check();
        expect(heard).toBe(1);
        off();
        present.push('/w/w');
        await r.missing.check();
        expect(heard).toBe(1);
        expect(r.changes()).toBe(2);
    });
});

describe('the cadence: every 10 s while one is missing, every 60 s otherwise', () => {
    it('the two intervals are 10 s and 60 s', async () => {
        const m = await missingModule();
        expect(m.MISSING_RECHECK_MS).toBe(10_000);
        expect(m.PRESENT_RECHECK_MS).toBe(60_000);
    });

    it('follows what the last look found, one timer at a time', async () => {
        const present: string[] = [];
        const r = await rig([{ id: 'a', path: '/w/a' }, { id: 'b', path: '/w/b' }], (path) => only(present)(path));
        await r.missing.start();
        expect(r.pending.map((t) => t.ms)).toEqual([10_000]);

        // One of two is back: one is still missing, so still 10 s.
        present.push('/w/a');
        await r.fire();
        expect(r.missing.isMissing('a')).toBe(false);
        expect(r.pending.map((t) => t.ms)).toEqual([10_000]);

        // Both are there: 60 s.
        present.push('/w/b');
        await r.fire();
        expect(r.pending.map((t) => t.ms)).toEqual([60_000]);

        // One goes: back to 10 s at the next look.
        present.splice(0, 1);
        await r.fire();
        expect(r.missing.isMissing('a')).toBe(true);
        expect(r.pending.map((t) => t.ms)).toEqual([10_000]);
    });

    it('a look asked for between timers re-arms one timer, never a second', async () => {
        const r = await rig([{ id: 'a', path: '/w/a' }], only(['/w/a']));
        await r.missing.start();
        expect(r.pending.map((t) => t.ms)).toEqual([60_000]);
        await r.missing.check();
        await r.missing.check();
        expect(r.pending.map((t) => t.ms)).toEqual([60_000]);
    });

    it('nothing is scheduled before start, and stop cancels what was (start is the control)', async () => {
        const r = await rig([{ id: 'a', path: '/w/a' }], only([]));
        await r.missing.check();
        expect(r.missing.isMissing('a')).toBe(true);
        expect(r.pending).toEqual([]);
        await r.missing.start();
        expect(r.pending).toHaveLength(1);
        r.missing.stop();
        expect(r.pending).toEqual([]);
        await r.missing.check();
        expect(r.pending).toEqual([]);
    });
});

describe('never dropped, and nothing written by the look', () => {
    it('the module asks its ports for the registry, the look, the timer and the log only: it has no write to make', async () => {
        const r = await rig([{ id: 'gone', path: '/w/gone' }, { id: 'here', path: '/w/here' }], only(['/w/here']));
        await r.missing.start();
        await r.fire();
        r.missing.stop();
        // Positive control: the ports were really reached through the recorder.
        expect(r.used.has('workspaces')).toBe(true);
        expect(r.used.has('isDirectory')).toBe(true);
        expect(r.used.has('schedule')).toBe(true);
        expect([...r.used].filter((key) => !['workspaces', 'isDirectory', 'schedule', 'log'].includes(key))).toEqual([]);
    });

    async function estate() {
        const dir = tempRoot('genie-p7-missing-registry-');
        const gone = join(dir, 'gone'); const here = join(dir, 'here');
        mkdirSync(gone); mkdirSync(here);
        const store = new Store(dir);
        const registry = new Registry(store);
        await registry.load({ name: 'fixture-host', healthy: true });
        await registry.addWorkspace({ id: 'gone', path: gone });
        await registry.addWorkspace({ id: 'here', path: here });
        const atlas = await registry.register({ workspaceId: 'gone', provider: 'claude', name: 'atlas' });
        return { dir, store, registry, atlas, gone, here };
    }

    it('Registry.snapshot(): `missing: true` on that row only; the row is still there with its agents; the other row has no such key', async () => {
        const e = await estate();
        // Control: with nothing said, no row carries the key.
        for (const row of e.registry.snapshot().workspaces ?? []) expect('missing' in row).toBe(false);

        let emitted = 0;
        e.registry.subscribe(() => { emitted++; });
        e.registry.setMissingWorkspaces((id) => id === 'gone');
        // Windows hear it: the port is announced like the colourer is.
        expect(emitted).toBe(1);

        const snapshot = e.registry.snapshot();
        const rows = snapshot.workspaces ?? [];
        expect(rows.map((w) => w.id)).toEqual(['gone', 'here']);
        const goneRow = rows.find((w) => w.id === 'gone')!;
        const hereRow = rows.find((w) => w.id === 'here')!;
        expect(goneRow).toMatchObject({ id: 'gone', path: e.gone, missing: true, agentsKnown: true, asleep: false });
        expect('missing' in hereRow).toBe(false);
        // Its agents are still in the census.
        expect(snapshot.agents.filter((a) => a.workspaceId === 'gone').map((a) => a.name)).toEqual(['atlas']);
        // And it is still in the registry's own lists.
        expect(e.registry.listWorkspaces().map((w) => w.id)).toEqual(['gone', 'here']);
        expect(e.registry.workspace('gone')).toMatchObject({ id: 'gone', path: e.gone });
        expect(e.registry.agentsOf('gone').map((a) => a.id)).toEqual([e.atlas.id]);
    });

    it('the flag is never stored: no write is made for it, the file does not say it, and a registry read again has no flag', async () => {
        const e = await estate();
        const writeWorkspaces = vi.spyOn(e.store, 'writeWorkspaces');
        const writeAgents = vi.spyOn(e.store, 'writeAgents');
        e.registry.setMissingWorkspaces((id) => id === 'gone');
        expect(e.registry.snapshot().workspaces?.find((w) => w.id === 'gone')).toMatchObject({ missing: true });
        e.registry.touch();
        await e.registry.refresh();
        expect(writeWorkspaces).not.toHaveBeenCalled();
        expect(writeAgents).not.toHaveBeenCalled();
        // No RECORD has the key (the text itself may: a temp folder's own name said `missing` on the first run).
        const onDisk = JSON.parse(readFileSync(e.store.workspacesFile, 'utf8')) as Array<Record<string, unknown>>;
        expect(onDisk.map((w) => w['id'])).toEqual(['gone', 'here']);
        expect(onDisk.filter((w) => 'missing' in w)).toEqual([]);
        // Positive control: the spy sees a real write.
        await e.registry.addWorkspace({ id: 'third', path: join(e.dir, 'third') });
        expect(writeWorkspaces).toHaveBeenCalledTimes(1);

        const again = new Registry(new Store(e.dir));
        await again.load({ name: 'fixture-host', healthy: true });
        expect(again.listWorkspaces().map((w) => w.id)).toEqual(['gone', 'here', 'third']);
        for (const row of again.snapshot().workspaces ?? []) expect('missing' in row).toBe(false);
    });

    it('the real look over the real registry: the folder goes, the row is flagged and kept; it comes back, the flag goes', async () => {
        const { MissingWorkspaces, nodeIsDirectory } = await missingModule();
        const e = await estate();
        const missing = new MissingWorkspaces({ workspaces: () => e.registry.workspaceStates(), isDirectory: nodeIsDirectory, schedule: () => () => {} });
        e.registry.setMissingWorkspaces((id) => missing.isMissing(id));
        missing.onChange(() => e.registry.touch());
        const seen: (true | undefined)[] = [];
        e.registry.subscribe((snapshot) => { seen.push(snapshot.workspaces?.find((w) => w.id === 'gone')?.missing); });

        await missing.check();
        expect(e.registry.snapshot().workspaces?.find((w) => w.id === 'gone')?.missing).toBeUndefined();

        rmSync(e.gone, { recursive: true, force: true });
        await missing.check();
        expect(seen).toEqual([true]);
        expect(e.registry.snapshot().workspaces?.map((w) => w.id)).toEqual(['gone', 'here']);

        mkdirSync(e.gone);
        await missing.check();
        expect(seen).toEqual([true, undefined]);
    });
});

describe('a missing workspace starts no agent, said in words', () => {
    const record = { id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: 't', lastUsedAt: null, mode: 'manual', accessScope: 'self' } as unknown as AgentRecord;
    const awake = { workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: '/w/tynn', asleep: false } : null) };
    const asleep = { workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: '/w/tynn', asleep: true } : null) };
    const gone = { pathIfMissing: (id: string) => (id === 'tynn' ? '/w/tynn' : null) };
    const there = { pathIfMissing: () => null };
    const WORDS = 'tynn\'s folder is not there (/w/tynn): locate it from the Dashboard before starting atlas';

    it('refused, naming the workspace, the path, where to fix it and the agent', () => {
        expect(startRefusal({ registry: awake, missing: gone }, record)).toBe(WORDS);
    });

    it('a workspace whose folder is there starts (the control), with the port and without it', () => {
        expect(startRefusal({ registry: awake, missing: there }, record)).toBeNull();
        expect(startRefusal({ registry: awake }, record)).toBeNull();
    });

    it('hibernation is still said first', () => {
        const refusal = startRefusal({ registry: asleep, missing: gone }, record, { running: 9, cap: 4 });
        expect(refusal).toMatch(/hibernating/);
        expect(refusal).not.toMatch(/folder is not there/);
    });

    it('the cap still applies to a workspace that is there, and a missing folder is said before the cap', () => {
        expect(startRefusal({ registry: awake, missing: there }, record, { running: 4, cap: 4 })).toBe('tynn is at its cap of 4 running agents; stop one or raise agent_cap in the workspace settings before starting atlas');
        expect(startRefusal({ registry: awake, missing: there }, record, { running: 3, cap: 4 })).toBeNull();
        expect(startRefusal({ registry: awake, missing: gone }, record, { running: 4, cap: 4 })).toBe(WORDS);
        expect(startRefusal({ registry: awake, missing: gone }, record, { running: 0, cap: 4 })).toBe(WORDS);
    });

    it('the module itself is the port: refused while its folder is gone, started once it is back', async () => {
        const present: string[] = [];
        const r = await rig([{ id: 'tynn', path: '/w/tynn' }], (path) => only(present)(path));
        await r.missing.check();
        expect(startRefusal({ registry: awake, missing: r.missing }, record)).toBe(WORDS);
        present.push('/w/tynn');
        await r.missing.check();
        expect(startRefusal({ registry: awake, missing: r.missing }, record)).toBeNull();
    });
});

describe('genie-host wires it (read from the source: the host is not started in a unit test)', () => {
    const host = readFileSync(join(__dirname, '..', 'src', 'main', 'genie-host.ts'), 'utf8').replace(/\r\n/g, '\n');

    it('every start gate is told which workspaces are missing', () => {
        const gates = host.match(/startRefusal\(\{[^}]*\}/g) ?? [];
        // Positive control: the two gates (a person's start, a flow's start) are found.
        expect(gates.length).toBeGreaterThanOrEqual(2);
        for (const gate of gates) expect(gate).toContain('missing: missingWorkspaces');
    });

    it('looked at when the host starts, when the registry is written, and after Locate folder; a change reaches the windows', () => {
        expect(host).toMatch(/const missingWorkspaces = nodeMissingWorkspaces\(\(\) => hostRegistry\.workspaceStates\(\)/);
        expect(host).toMatch(/missingWorkspaces\.start\(\)/);
        expect(host).toMatch(/missingWorkspaces\.onChange\(\(\) => \{ phoneRegistryNow\?\.touch\(\); \}\)/);
        expect(host).toMatch(/phoneRegistry\.setMissingWorkspaces\(\(id\) => missingWorkspaces\.isMissing\(id\)\)/);
        expect(host).toMatch(/event\.store === 'registry'\) \{[^}]*missingWorkspaces\.check\(\)/);
        expect(host).toMatch(/recheckMissing: \(\) => missingWorkspaces\.check\(\)/);
    });
});
