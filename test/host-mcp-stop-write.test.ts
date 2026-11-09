import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * HostMcp.stop() WAITS FOR THE ENDPOINT WRITE (Tynn #583). The host remembers its endpoint in a private file and did not
 * wait for that write, nor did stop(), so a stop could return while the write (an ACL step of about 300 ms on Windows) was
 * still creating its temp file. V3's Windows job failed on exactly that: `ENOTEMPTY … rmdir …genie-live-tools-endpoints-…`.
 * Here the write is held open, so the race is forced on every OS and nothing depends on timing.
 */
const held = vi.hoisted(() => ({ gate: null as Promise<void> | null, started: 0 }));
vi.mock('../src/main/store.js', async (original) => ({
    ...(await original<typeof import('../src/main/store.js')>()),
    writeTextPrivate: async () => { held.started += 1; if (held.gate) await held.gate; },
}));

const { startHostMcp } = await import('../src/main/host-mcp.js');
type Ports = Parameters<typeof startHostMcp>[0];

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-stop-write-')); held.started = 0; held.gate = null; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const never = () => { throw new Error('not exercised'); };
const ports = (log: string[]): Ports => ({
    stores: { inbox: never, attention: never, knowledge: never, approvals: { gate: async () => 'denied' } } as never,
    settings: { snapshot: () => ({}), snapshotFor: () => ({}) } as never,
    records: () => [],
    registry: { workspace: () => null, workspaceSlugs: () => new Map(), defaultAgentOf: () => null, setNames: () => {} } as never,
    probe: never as never,
    lastRowAt: () => null,
    reportPlan: () => true,
    window: { connected: () => false, call: async () => ({ text: 'forwarded', isError: true }) },
    openFileLater: () => {},
    signal: () => {},
    endpointFile: join(dir, 'mcp-endpoint.json'),
    osaDir: join(dir, 'osa'),
    log: (line) => log.push(line),
});
const until = async (ok: () => boolean) => {
    const end = Date.now() + 10_000;
    while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};
const moment = () => new Promise((r) => setTimeout(r, 50));

describe('stop() and the endpoint write', () => {
    it('stop() does not finish while the endpoint write is still in flight; it finishes when the write does', async () => {
        let release: () => void = () => {};
        held.gate = new Promise<void>((r) => { release = r; });
        const mcp = startHostMcp(ports([]));
        await until(() => mcp.endpoint() !== null && held.started === 1);
        let stopped = false;
        const stopping = mcp.stop().then(() => { stopped = true; });
        await moment();
        expect(stopped).toBe(false);
        release();
        await stopping;
        expect(stopped).toBe(true);
    });

    it('CONTROL: with no write in flight, stop() finishes at once', async () => {
        const mcp = startHostMcp(ports([]));
        await until(() => mcp.endpoint() !== null && held.started === 1);
        await moment();
        await mcp.stop();
    });

    it('a write that fails neither blocks nor fails the stop, and is said in the log', async () => {
        const log: string[] = [];
        held.gate = Promise.reject(new Error('disk said no'));
        held.gate.catch(() => {});
        const mcp = startHostMcp(ports(log));
        await until(() => mcp.endpoint() !== null && held.started === 1);
        await expect(mcp.stop()).resolves.toBeUndefined();
        expect(log.join('\n')).toContain('could not remember its endpoint: disk said no');
    });
});
