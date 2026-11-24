import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hostingTrust from '../src/main/hosting-trust.js';
import { ownTrust, type OwnTrust, type OwnTrustInput } from '../src/main/hosting-trust.js';
import { nodeEnvelopeFs } from '../src/main/envelope-sites-host.js';

/*
 * THE HOSTING'S OWN TRUST, AROUND ITS READS (Tynn #955).
 *
 * - THE WATCH TAKES ITS FIRST READINGS BEFORE THE VERDICT IS READ. The watch reads the verdict again only when a file's
 *   reading differs from the one before. If the verdict was read first and a file arrived before the watch took its
 *   first readings, those readings already held the file: no difference, ever, and the workspace went on reading
 *   "trusted, nothing would run".
 * - A READ THAT FAILED IS TRIED AGAIN. What could not be read is not trusted (workspace-trust-read-order-955); it must
 *   not sit unread until some file happens to change. Tried again after a while, a longer while each time up to a
 *   limit, until it is read or the workspace is gone.
 */

const COMMAND = JSON.stringify({ mcpServers: { theirs: { command: 'node', args: ['server.js'] } } });
const record = () => {
    const book = { carried: [] as string[], workspaces: {} as Record<string, string> };
    return { trustRecord: () => book, recordWorkspace: async (id: string, hash: string) => { book.workspaces[id] = hash; }, forgetWorkspaceTrust: async (id: string) => { delete book.workspaces[id]; }, approveSites: async () => {} };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let own: OwnTrust | null = null;
let dir: string | null = null;
afterEach(async () => {
    await own?.close();
    own = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
});

describe('the watch takes its first readings before the verdict is read', () => {
    it('a file that arrives between the two is seen: the workspace is not left "trusted, nothing would run"', async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-trust-baseline-955-'));
        const workspace = join(dir, 'work');
        await mkdir(workspace);
        const mcp = join(workspace, '.mcp.json');
        const real = nodeEnvelopeFs().readText;
        let arrived!: () => void;
        const fileArrived = new Promise<void>((r) => { arrived = r; });
        let first = true;
        own = ownTrust({
            workspaces: () => [{ id: 'work', path: workspace }],
            envelopeSites: record(),
            readText: async (path) => {
                // Only the watch reads a folder's `.git` as a file (where a submodule's git config is): it goes on to take
                // its readings only once the file has arrived, or it would be a matter of which read is quicker.
                if (path === join(workspace, '.git')) await Promise.race([fileArrived, sleep(2_000)]);
                const text = await real(path);
                // The file arrives right after the first time anything reads `.mcp.json` and finds none.
                if (path === mcp && first) { first = false; writeFileSync(mcp, COMMAND); arrived(); }
                return text;
            },
            watchFolders: false,
            everyMs: 20,
        });
        await vi.waitFor(() => { expect(own!.api.view('work')).not.toBeNull(); }, { timeout: 10_000, interval: 10 });
        // Several slow passes: each compares its readings with the ones before, and reads the verdict again on a difference.
        await sleep(400);
        expect(own.api.view('work')).toMatchObject({ trusted: false, list: { servers: [{ file: '.mcp.json', name: 'theirs' }] } });
    }, 20_000);
});

describe('a read that failed is tried again', () => {
    const W = join('/__genie955_fixture__', 'acme');
    const MCP = join(W, '.mcp.json');
    const busy = () => Object.assign(new Error("EBUSY: resource busy or locked, open '.mcp.json'"), { code: 'EBUSY' });

    function rig(over: { failFor?: number } = {}) {
        const files = new Map<string, string>();
        const state = { failing: false, failuresLeft: over.failFor ?? Number.POSITIVE_INFINITY, here: true, mcpReads: 0 };
        const asked: number[] = [];
        own = ownTrust({
            workspaces: () => (state.here ? [{ id: 'acme', path: W }] : []),
            envelopeSites: record(),
            readText: async (path) => {
                if (path === MCP) {
                    state.mcpReads++;
                    if (state.failing && state.failuresLeft > 0) { state.failuresLeft--; throw busy(); }
                }
                return files.get(path) ?? null;
            },
            watchFolders: false,
            everyMs: 3_600_000,
            // How long until the read is tried again, asked with how many reads in a row have failed.
            retryMs: (failures: number) => { asked.push(failures); return 10; },
        } as OwnTrustInput);
        return { files, state, asked };
    }

    it('trusted because nothing would run, then a file that cannot be read: read again until it can be, and then the verdict is the file’s', async () => {
        // Fails for the read that is asked for, and for the first two tries after it.
        const r = rig({ failFor: 3 });
        await vi.waitFor(() => { expect(own!.api.view('acme')).toMatchObject({ trusted: true }); }, { timeout: 10_000, interval: 10 });
        r.files.set(MCP, COMMAND);
        r.state.failing = true;
        await expect(own!.api.refresh('acme')).rejects.toThrow(/EBUSY/);
        expect(own!.api.view('acme')?.trusted === true).toBe(false);
        // Nobody asks again. It is read again all the same.
        await vi.waitFor(() => { expect(own!.api.view('acme')).toMatchObject({ trusted: false, list: { servers: [{ name: 'theirs' }] } }); }, { timeout: 10_000, interval: 10 });
        // Each wait was asked with one more failure than the last; once it is read, nothing more is tried.
        expect(r.asked).toEqual([1, 2, 3]);
        const reads = r.state.mcpReads;
        await sleep(150);
        expect(r.state.mcpReads).toBe(reads);
        expect(r.asked).toEqual([1, 2, 3]);
    }, 30_000);

    it('the workspace goes away while it cannot be read: the tries stop', async () => {
        const r = rig();
        await vi.waitFor(() => { expect(own!.api.view('acme')).toMatchObject({ trusted: true }); }, { timeout: 10_000, interval: 10 });
        r.state.failing = true;
        await expect(own!.api.refresh('acme')).rejects.toThrow(/EBUSY/);
        // The control: it IS being tried again while the workspace is here.
        await vi.waitFor(() => { expect(r.asked.length).toBeGreaterThanOrEqual(3); }, { timeout: 10_000, interval: 10 });
        r.state.here = false;
        await sleep(100);
        const reads = r.state.mcpReads, asks = r.asked.length;
        await sleep(200);
        expect(r.state.mcpReads).toBe(reads);
        expect(r.asked.length).toBe(asks);
    }, 30_000);

    it('closed while it cannot be read: nothing is tried after', async () => {
        const r = rig();
        await vi.waitFor(() => { expect(own!.api.view('acme')).toMatchObject({ trusted: true }); }, { timeout: 10_000, interval: 10 });
        r.state.failing = true;
        await expect(own!.api.refresh('acme')).rejects.toThrow(/EBUSY/);
        await own!.close();
        const reads = r.state.mcpReads;
        await sleep(200);
        expect(r.state.mcpReads).toBe(reads);
    }, 30_000);

    it('the wait grows and has a limit: 1 s, 2 s, 4 s … and never more than a minute', () => {
        const delay = (hostingTrust as unknown as { trustRetryDelayMs?: (failures: number) => number }).trustRetryDelayMs;
        expect(delay, 'hosting-trust.ts exports trustRetryDelayMs').toBeTypeOf('function');
        expect([1, 2, 3, 4, 5, 6, 7, 8, 30, 1000].map((n) => delay!(n))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
    });
});
