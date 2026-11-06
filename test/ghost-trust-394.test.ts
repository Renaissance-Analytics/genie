import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trustHash } from '../src/core/workspace-trust.js';
import { ownTrust } from '../src/main/hosting-trust.js';
import { TrustWatch } from '../src/main/trust-watch.js';
import { WorkspaceTrust, readTrustList, type TrustView, type WorkspaceTrustPorts } from '../src/main/workspace-trust-host.js';

const root = join('/__genie394_fixture__', 'trust');
type Refresh = (id: string, purpose?: 'redock') => Promise<TrustView | null>;
const redock = (trust: WorkspaceTrust) => (trust.refresh as Refresh).call(trust, 'workspace', 'redock');
afterEach(() => { vi.useRealTimers(); });

async function fixture() {
    const workspace = { id: 'workspace', path: root, asleep: false };
    const files = new Map([[join(root, '.mcp.json'), JSON.stringify({ mcpServers: { theirs: { command: 'before' } } })]]);
    const book = { carried: [] as string[], workspaces: {} as Record<string, string> };
    const reads: string[] = [];
    let held: Promise<void> | null = null, failed = false;
    const git = vi.fn(async () => []), record = vi.fn(async (id: string, hash: string) => { book.workspaces[id] = hash; });
    const ports: WorkspaceTrustPorts = { workspaces: () => [workspace], record: () => book, recordWorkspace: record, approveSites: async () => {}, gitConfig: git,
        readText: async (path) => { reads.push(path); if (path === join(root, '.mcp.json')) { if (held) await held; if (failed) throw new Error('trust read refused'); } return files.get(path) ?? null; },
    };
    book.workspaces.workspace = trustHash(await readTrustList(root, ports));
    const trust = new WorkspaceTrust(ports);
    expect(await trust.refresh('workspace')).toMatchObject({ trusted: true, changed: false });
    reads.length = 0; git.mockClear();
    return { workspace, trust, reads, git, files, book, record, hold: (promise: Promise<void>) => { held = promise; }, fail: () => { failed = true; } };
}

describe('story394: trust has no asleep folder reads and redock never reuses a stale yes', () => {
    it('ordinary refresh and approval cannot reopen an asleep folder, and its cached yes is not live trust', async () => {
        const f = await fixture(); f.workspace.asleep = true;
        expect(f.trust.isTrustedPath(root)).toBe(false);
        expect(f.trust.view('workspace')?.trusted).not.toBe(true);
        expect(await f.trust.refresh('workspace')).toBeNull();
        expect(await f.trust.trust('workspace')).toBeNull();
        expect(f.reads).toEqual([]); expect(f.git).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
    });

    it('redock fails closed during the fresh read and catches configuration changed while asleep without approving it', async () => {
        const f = await fixture(); const before = f.book.workspaces.workspace;
        f.workspace.asleep = true;
        f.files.set(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { theirs: { command: 'changed while asleep' } } }));
        let release!: () => void; f.hold(new Promise<void>((resolve) => { release = resolve; }));
        const reading = redock(f.trust);
        try {
            // Even if another metadata reader observes awake before the read finishes, the old yes is invalidated.
            f.workspace.asleep = false;
            expect(f.trust.isTrustedPath(root)).toBe(false);
        } finally { release(); }
        expect(await reading).toMatchObject({ trusted: false, changed: true });
        expect(f.book.workspaces.workspace).toBe(before); expect(f.record).not.toHaveBeenCalled();
    });

    it('a failed redock read leaves the old trust revoked rather than falling back to its cached yes', async () => {
        const f = await fixture(); f.workspace.asleep = true; f.fail();
        await expect(redock(f.trust)).rejects.toThrow('trust read refused');
        f.workspace.asleep = false;
        expect(f.trust.isTrustedPath(root)).toBe(false); expect(f.record).not.toHaveBeenCalled();
    });

    it('the owning trust factory refuses writes and advertises no trust entry for an asleep workspace without reading it', async () => {
        const read = vi.fn(async () => null);
        const own = ownTrust({ workspaces: () => [{ id: 'workspace', path: root, asleep: true }], envelopeSites: { trustRecord: () => ({ carried: [], workspaces: {} }), recordWorkspace: async () => {}, approveSites: async () => {} }, readText: read, watchFolders: false, everyMs: 1_000_000 });
        try { expect(await own.api.mayWriteInto(root)).toBe(false); expect(own.api.entries()).toEqual([]); expect(read).not.toHaveBeenCalled(); }
        finally { await own.close(); }
    });
});

describe('story394: asleep trust watches are metadata only', () => {
    const rig = (asleep: boolean) => {
        const workspace = { id: 'workspace', path: root, asleep };
        const read = vi.fn(async () => null), fingerprint = vi.fn(async () => null), close = vi.fn(), refresh = vi.fn();
        const callbacks: Array<() => void> = [];
        const watch = new TrustWatch({ workspaces: () => [workspace], readText: read, fingerprint, watchFolder: (_path, changed) => { callbacks.push(changed); return close; }, refresh, settleMs: 10 });
        return { workspace, read, fingerprint, close, refresh, callbacks, watch };
    };
    it('creates no watcher, manifest/git-pointer read or fingerprint on an asleep boot', async () => {
        const f = rig(true);
        try { await f.watch.pass(); expect(f.read).not.toHaveBeenCalled(); expect(f.fingerprint).not.toHaveBeenCalled(); expect(f.watch.watching).toEqual([]); }
        finally { f.watch.stop(); }
    });
    it('hibernation closes existing watches and pending callbacks; redock establishes fresh watches', async () => {
        vi.useFakeTimers(); const f = rig(false);
        try {
            await f.watch.pass(); expect(f.read).toHaveBeenCalled(); expect(f.watch.watching.length).toBeGreaterThan(0);
            f.callbacks[0]!(); f.workspace.asleep = true; f.read.mockClear(); f.fingerprint.mockClear();
            await f.watch.pass(); expect(f.watch.watching).toEqual([]); expect(f.close).toHaveBeenCalled();
            f.callbacks[0]!(); await vi.advanceTimersByTimeAsync(20);
            expect(f.read).not.toHaveBeenCalled(); expect(f.fingerprint).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
            f.workspace.asleep = false; await f.watch.pass(); expect(f.read).toHaveBeenCalled(); expect(f.watch.watching.length).toBeGreaterThan(0);
        } finally { f.watch.stop(); }
    });
});
