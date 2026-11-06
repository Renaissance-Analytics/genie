import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trustHash, type TrustList } from '../src/core/workspace-trust.js';
import { WorkspaceTrust, readTrustList, type WorkspaceTrustPorts } from '../src/main/workspace-trust-host.js';

/*
 * A CARRIED WORKSPACE'S LIST IS RECORDED ONLY FROM A SETTLED READ (genie#1519; the line's flake, run 42277250815). At the
 * upgrade every registered workspace carried over, and its first list read with something on it is recorded "now, once",
 * so a later change asks. compose does not await the boot's first pass: one that read the files while they were being
 * written recorded HALF a list, and the next read of the whole one said "changed" — untrusted, and Genie's reconcile of its
 * own legacy entry skipped. Now the list is read again until two reads agree (5 tries, a wait apart). One that never settles
 * records nothing and stays untrusted: an unstable read never grants trust. A list that changes after a settled record still
 * asks.
 */
const W = join('/ws', 'acme');
const at = (...parts: string[]) => join(W, ...parts);
const THEIRS = JSON.stringify({ mcpServers: { keep: { command: 'user-server' } } });
const THEIRS_TOO = JSON.stringify({ mcpServers: { also: { command: 'user-server-two' } } });

function rig(read: (path: string, files: Map<string, string>) => string | null) {
    const files = new Map<string, string>([[at('.mcp.json'), THEIRS], [at('.cursor', 'mcp.json'), THEIRS_TOO]]);
    const book = { carried: ['acme'] as string[], workspaces: {} as Record<string, string> };
    const recorded: string[] = [];
    const waits: number[] = [];
    const ports: WorkspaceTrustPorts = {
        workspaces: () => [{ id: 'acme', path: W }],
        readText: async (p) => read(p, files),
        gitConfig: async () => [],
        record: () => book,
        recordWorkspace: async (id, hash) => { book.workspaces[id] = hash; recorded.push(hash); },
        approveSites: async () => {},
        wait: async (ms) => { waits.push(ms); },
    };
    const whole = async (): Promise<TrustList> => readTrustList(W, { readText: async (p) => files.get(p) ?? null, gitConfig: async () => [] });
    return { trust: new WorkspaceTrust(ports), files, book, recorded, waits, whole };
}

describe('a carried workspace, read while its files are being written', () => {
    it('PROBE: the first read misses a file being written; the list recorded is the WHOLE one, and the verdict is trusted, not "changed"', async () => {
        let missed = false;
        const r = rig((p, files) => {
            // The boot pass reads .cursor/mcp.json a moment before it lands on disk: the first read of it finds nothing.
            if (p === at('.cursor', 'mcp.json') && !missed) { missed = true; return null; }
            return files.get(p) ?? null;
        });
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.recorded).toEqual([trustHash(await r.whole())]);
        // The next read of the same files (syncConfig's, through mayWriteInto) agrees: trusted, nothing asked.
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
    });

    it('a list that never settles records nothing and stays untrusted (an unstable read never grants trust), after 5 reads, a wait apart', async () => {
        let n = 0;
        const r = rig((p, files) => (p === at('.cursor', 'mcp.json') ? ((n++ % 2 === 0) ? null : files.get(p)!) : files.get(p) ?? null));
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false, changed: false });
        expect(r.recorded).toEqual([]);
        expect(r.book.workspaces).toEqual({});
        expect(r.waits).toEqual([50, 50, 50, 50]);
    });

    it('CONTROL: settled from the first read, it records at once with no wait', async () => {
        const r = rig((p, files) => files.get(p) ?? null);
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: true, changed: false });
        expect(r.recorded).toEqual([trustHash(await r.whole())]);
        expect(r.waits).toEqual([]);
    });

    it('a list that really changed after a settled record still reads "changed"', async () => {
        const r = rig((p, files) => files.get(p) ?? null);
        await r.trust.refresh('acme');
        r.files.set(at('.mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'user-server' }, added: { command: 'something-new' } } }));
        expect(await r.trust.refresh('acme')).toMatchObject({ trusted: false, changed: true });
        expect(r.recorded).toHaveLength(1);
    });
});
