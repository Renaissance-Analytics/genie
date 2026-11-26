import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitConfigEntry } from '../src/core/workspace-trust.js';
import { WorkspaceTrust } from '../src/main/workspace-trust-host.js';

/*
 * AN OLDER READ NEVER REPLACES A NEWER ONE, AND WHAT COULD NOT BE READ IS NOT TRUSTED (Tynn #955).
 *
 * Trust decides what a workspace's own files may run. A workspace nobody said yes to is trusted only while nothing in it
 * would run, so a read that found "no file" is worth a yes. Reading takes several steps (files, then git, then folders),
 * and several things read at once: the hosting's own pass, the watcher, an agent's start, Genie's own writes, the
 * person's Untrust. A read that began before a file existed and finished after a newer read saw it used to be kept, as
 * the last to land: TRUSTED, with the file there and no yes given (the Windows red in split-2g4d-e2b-trust-share-link).
 *
 * The files are a map and the slow step (git) is held by hand, so each ordering is made certain, not waited for.
 */

const W = join('/ws', 'acme');
const MCP = join(W, '.mcp.json');
const COMMAND = JSON.stringify({ mcpServers: { theirs: { command: 'node', args: ['server.js'] } } });

interface Held { readonly reached: Promise<void>; release(): void }

function fixture(start: { carried?: string[]; workspaces?: Record<string, string> } = {}) {
    const files = new Map<string, string>();
    const record = { carried: [...(start.carried ?? [])], workspaces: { ...(start.workspaces ?? {}) } as Record<string, string> };
    /** What the next reads of a path do instead of answering from the map. */
    const failing = new Map<string, Error>();
    /** The git step of the next reads, held in the order they arrive: `hold()` before the read it is for. */
    const holds: Array<{ arrived: () => void; gate: Promise<void> }> = [];
    /** The same for the next reads of `.mcp.json`: held BEFORE the file is looked at. */
    const readHolds: Array<{ arrived: () => void; gate: Promise<void> }> = [];
    let gitReads = 0;
    let duringGit: (() => Promise<void>) | null = null;
    const holdIn = (list: typeof holds) => (): Held => {
        let arrived!: () => void, release!: () => void;
        const reached = new Promise<void>((r) => { arrived = r; });
        const gate = new Promise<void>((r) => { release = r; });
        list.push({ arrived, gate });
        return { reached, release };
    };
    const hold = holdIn(holds), holdRead = holdIn(readHolds);
    const trust = new WorkspaceTrust({
        readText: async (path) => {
            const error = failing.get(path);
            if (error) throw error;
            const held = path === MCP ? readHolds.shift() : undefined;
            if (held) { held.arrived(); await held.gate; }
            return files.get(path) ?? null;
        },
        // The slow step, after every file of the list has been read (workspace-trust-host.ts readTrustList).
        gitConfig: async (): Promise<GitConfigEntry[]> => {
            gitReads++;
            const held = holds.shift();
            if (held) { held.arrived(); await held.gate; }
            const during = duringGit;
            if (during) { duringGit = null; await during(); }
            return [];
        },
        workspaces: () => [{ id: 'acme', path: W }],
        record: () => record,
        recordWorkspace: async (id, hash) => { record.workspaces[id] = hash; },
        forgetWorkspace: async (id) => { delete record.workspaces[id]; record.carried = record.carried.filter((c) => c !== id); },
        approveSites: async () => {},
    });
    return { trust, files, record, failing, hold, holdRead, gitReads: () => gitReads, duringGit: (work: () => Promise<void>) => { duringGit = work; } };
}

const trusted = (f: ReturnType<typeof fixture>) => f.trust.view('acme')?.trusted === true;

describe('two reads of one workspace at once: the older one landing last', () => {
    it('a read that began before the file existed, landing after a newer read saw it, does not make the workspace trusted', async () => {
        const f = fixture();
        const slow = f.hold();
        const older = f.trust.refresh('acme');
        await slow.reached;
        // The older read has read every file ("no .mcp.json") and is in its git step. The file arrives; a newer read sees it.
        f.files.set(MCP, COMMAND);
        expect((await f.trust.refresh('acme'))?.trusted).toBe(false);
        expect(trusted(f)).toBe(false);
        slow.release();
        const late = await older;
        expect(trusted(f)).toBe(false);
        // What the late read answers is what a caller decides by (mayWriteInto, an agent's start): the file is on it.
        expect(late?.trusted).toBe(false);
        expect(late?.list.servers).toEqual([{ file: '.mcp.json', name: 'theirs', command: 'node server.js' }]);
    });

    it('Untrust, then a read that began before the file existed lands: it stays untrusted (the fixture’s ordering)', async () => {
        // As the hosting meets a workspace on a fresh record: carried, so trusted; its first pass is reading.
        const f = fixture({ carried: ['acme'] });
        const slow = f.hold();
        const firstPass = f.trust.refresh('acme');
        await slow.reached;
        f.files.set(MCP, COMMAND);
        expect((await f.trust.untrust('acme'))?.trusted).toBe(false);
        expect(trusted(f)).toBe(false);
        slow.release();
        expect((await firstPass)?.trusted).toBe(false);
        expect(trusted(f)).toBe(false);
        expect(f.record).toEqual({ carried: [], workspaces: {} });
    });

    it('the read that STARTED later can be the older one: it read "no file" first, and lands last', async () => {
        const f = fixture();
        // The first to start is held before it looks at `.mcp.json`.
        const beforeFile = f.holdRead();
        const startedFirst = f.trust.refresh('acme');
        await beforeFile.reached;
        // The second starts after it, reads "no file", and is held in its git step.
        const inGit = f.hold();
        const startedLater = f.trust.refresh('acme');
        await inGit.reached;
        // The file arrives. The first to start now reads it, and lands: not trusted.
        f.files.set(MCP, COMMAND);
        beforeFile.release();
        expect((await startedFirst)?.trusted).toBe(false);
        expect(trusted(f)).toBe(false);
        // The one that started later lands last, holding the older reading. Keeping "the latest started" would keep it.
        inGit.release();
        expect((await startedLater)?.trusted).toBe(false);
        expect(trusted(f)).toBe(false);
    });

    it('a workspace where nothing would run is still trusted when two reads cross: the late one reads again, it is not just dropped', async () => {
        const f = fixture();
        const slow = f.hold();
        const older = f.trust.refresh('acme');
        await slow.reached;
        expect((await f.trust.refresh('acme'))?.trusted).toBe(true);
        slow.release();
        expect((await older)?.trusted).toBe(true);
        expect(trusted(f)).toBe(true);
    });

    it('the person’s yes is by the record: a read landing late after Trust leaves it trusted', async () => {
        const f = fixture();
        f.files.set(MCP, COMMAND);
        const slow = f.hold();
        const older = f.trust.refresh('acme');
        await slow.reached;
        expect((await f.trust.trust('acme'))?.trusted).toBe(true);
        slow.release();
        expect((await older)?.trusted).toBe(true);
        expect(trusted(f)).toBe(true);
    });

    // THE RULE SINCE Tynn #364. A read crossed READS_WHEN_CROSSED times gives up. Its own reading never says "trusted" (only
    // the record's yes does), and it never overwrites a verdict kept AFTER it began (by the write count) from a reading made
    // alone or from the person's yes: that verdict is a complete read at least as fresh, and it is the answer.

    it('a read crossed every time, with no fresher complete verdict kept (each crossing ends in a read that failed): it is not trusted', async () => {
        const f = fixture();
        let crossings = 0;
        // Each crossing: a read alone keeps "trusted, nothing would run", then a read that fails forgets it (EBUSY).
        const cross = async (): Promise<void> => {
            crossings++;
            expect((await f.trust.refresh('acme'))?.trusted).toBe(true);
            f.failing.set(MCP, Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
            await expect(f.trust.refresh('acme')).rejects.toThrow(/EBUSY/);
            f.failing.clear();
            expect(f.trust.view('acme')).toBeNull();
            f.duringGit(cross);
        };
        f.duringGit(cross);
        const before = f.gitReads();
        const view = await f.trust.refresh('acme');
        f.duringGit(async () => {});
        expect(crossings).toBe(3);
        // Bounded: its own three readings and each crossing's own read.
        expect(f.gitReads() - before).toBeLessThanOrEqual(8);
        // Nothing would run here, and no yes was given: a read that was never left alone may not say "trusted".
        expect(view?.trusted).toBe(false);
        expect(trusted(f)).toBe(false);
        // The next read left alone says what is so.
        expect((await f.trust.refresh('acme'))?.trusted).toBe(true);
        expect(trusted(f)).toBe(true);
    });

    it('THE CASE FOUND: three reads alone keep "trusted" while a fourth is crossed by each: it gives up and answers with theirs, overwriting nothing', async () => {
        const f = fixture();
        let crossings = 0;
        const cross = async (): Promise<void> => {
            crossings++;
            expect((await f.trust.refresh('acme'))?.trusted).toBe(true);
            f.duringGit(cross);
        };
        f.duringGit(cross);
        const view = await f.trust.refresh('acme');
        f.duringGit(async () => {});
        expect(crossings).toBe(3);
        const kept = f.trust.view('acme');
        expect(view?.trusted).toBe(true);
        // The very verdict the last read alone kept: nothing new was written over it.
        expect(view).toBe(kept);
        expect(f.record).toEqual({ carried: [], workspaces: {} });
    });

    it('a read alone that says NOT trusted is not turned into trusted by a crossed read: crossed every time by reads that see the file, it answers not trusted', async () => {
        const f = fixture();
        // Each crossing: the file is there for a read alone (not trusted), and gone again before the crossed read reads on, so
        // every reading of the crossed read finds nothing would run.
        const cross = async (): Promise<void> => {
            f.files.set(MCP, COMMAND);
            expect((await f.trust.refresh('acme'))?.trusted).toBe(false);
            f.files.delete(MCP);
            f.duringGit(cross);
        };
        f.duringGit(cross);
        const view = await f.trust.refresh('acme');
        f.duringGit(async () => {});
        expect(view?.trusted).toBe(false);
        expect(trusted(f)).toBe(false);
        expect(f.trust.view('acme')?.list.servers).toEqual([{ file: '.mcp.json', name: 'theirs', command: 'node server.js' }]);
    });

    it('crossed every time by an Untrust that finds the file: not trusted, and the record holds no yes', async () => {
        const f = fixture({ carried: ['acme'] });
        f.files.set(MCP, COMMAND);
        const cross = async (): Promise<void> => {
            expect((await f.trust.untrust('acme'))?.trusted).toBe(false);
            f.duringGit(cross);
        };
        f.duringGit(cross);
        const view = await f.trust.refresh('acme');
        f.duringGit(async () => {});
        expect(view?.trusted).toBe(false);
        expect(trusted(f)).toBe(false);
        expect(f.record).toEqual({ carried: [], workspaces: {} });
    });

    it('control: the person’s yes is by the record: crossed every time by reads that see the file, a workspace the person trusted stays trusted', async () => {
        const f = fixture();
        f.files.set(MCP, COMMAND);
        expect((await f.trust.trust('acme'))?.trusted).toBe(true);
        const cross = async (): Promise<void> => {
            expect((await f.trust.refresh('acme'))?.trusted).toBe(true);
            f.duringGit(cross);
        };
        f.duringGit(cross);
        const view = await f.trust.refresh('acme');
        f.duringGit(async () => {});
        expect(view?.trusted).toBe(true);
        expect(trusted(f)).toBe(true);
    });
});

describe('a workspace that could not be read is not trusted until a read succeeds', () => {
    const busy = () => Object.assign(new Error("EBUSY: resource busy or locked, open '.mcp.json'"), { code: 'EBUSY' });

    it('trusted because nothing would run, then a file that cannot be read: the old verdict does not stand', async () => {
        const f = fixture();
        expect((await f.trust.refresh('acme'))?.trusted).toBe(true);
        // The file is there, being written: the read of it fails (Windows: EBUSY, EPERM).
        f.files.set(MCP, COMMAND);
        f.failing.set(MCP, busy());
        await expect(f.trust.refresh('acme')).rejects.toThrow(/EBUSY/);
        expect(trusted(f)).toBe(false);
        expect(f.trust.isTrustedPath(join(W, 'src'))).toBe(false);
        // Read again once it can be: the verdict is the file's.
        f.failing.clear();
        expect((await f.trust.refresh('acme'))?.trusted).toBe(false);
        f.files.delete(MCP);
        expect((await f.trust.refresh('acme'))?.trusted).toBe(true);
    });

    it('Untrust is saved, then its read fails: the workspace does not stay trusted in what everything reads', async () => {
        const f = fixture({ carried: ['acme'] });
        f.files.set(MCP, COMMAND);
        expect((await f.trust.refresh('acme'))?.trusted).toBe(true);
        f.failing.set(MCP, busy());
        await expect(f.trust.untrust('acme')).rejects.toThrow(/EBUSY/);
        expect(f.record).toEqual({ carried: [], workspaces: {} });
        expect(trusted(f)).toBe(false);
    });

    it('control: the person’s yes is durable (Tynn #618): a read that fails does not take it back', async () => {
        const f = fixture();
        f.files.set(MCP, COMMAND);
        expect((await f.trust.trust('acme'))?.trusted).toBe(true);
        f.failing.set(MCP, busy());
        await expect(f.trust.refresh('acme')).rejects.toThrow(/EBUSY/);
        expect(trusted(f)).toBe(true);
    });

    it('control: not trusted, then a read that fails: it is still not trusted, and its list is still there to show', async () => {
        const f = fixture();
        f.files.set(MCP, COMMAND);
        expect((await f.trust.refresh('acme'))?.trusted).toBe(false);
        f.failing.set(MCP, busy());
        await expect(f.trust.refresh('acme')).rejects.toThrow(/EBUSY/);
        expect(f.trust.view('acme')).toMatchObject({ trusted: false, list: { servers: [{ name: 'theirs' }] } });
    });
});
