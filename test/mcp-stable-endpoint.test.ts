import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { genieMcpServer, type GenieMcpServer } from '../src/main/mcp-server.js';

/**
 * GENIE'S MCP KEEPS ITS ADDRESS ACROSS LAUNCHES. The loopback server bound a random port and minted a random bearer
 * token at every launch, so every config-synced file (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`) and
 * every harness that read one went stale at each restart — the owner's agent tried `127.0.0.1:51717`. Now the port and
 * token are remembered: reused on the next launch; when that port is taken the server binds a new one, keeps the token,
 * and remembers the new port.
 */
const started: GenieMcpServer[] = [];
const blockers: Server[] = [];
afterEach(async () => {
    for (const s of started.splice(0)) await s.stop();
    for (const b of blockers.splice(0)) await new Promise<void>((r) => b.close(() => r()));
});
const portOf = (url: string) => Number(new URL(url).port);
const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

describe('the remembered endpoint', () => {
    it('with nothing remembered: binds, and remembers the port and token it got', async () => {
        const written: unknown[] = [];
        const mcp = genieMcpServer({ registrations: [], remember: { read: () => null, write: (v) => { written.push(v); } } });
        started.push(mcp);
        const e = await mcp.start();
        expect(written).toEqual([{ port: portOf(e.url), token: e.token }]);
        expect(e.token.length).toBeGreaterThan(20);
    });

    it('reuses the remembered port and token, and writes nothing new', async () => {
        const port = await freePort();
        const written: unknown[] = [];
        const mcp = genieMcpServer({ registrations: [], remember: { read: () => ({ port, token: 'remembered-token-0123456789abcdef' }), write: (v) => { written.push(v); } } });
        started.push(mcp);
        const e = await mcp.start();
        expect(portOf(e.url)).toBe(port);
        expect(e.token).toBe('remembered-token-0123456789abcdef');
        expect(written).toEqual([]);
        expect(await mcp.verify()).toMatchObject({ ok: true });
    });

    it('the remembered port taken: a new port, the SAME token, and the new port remembered', async () => {
        const blocker = createServer();
        await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
        blockers.push(blocker);
        const taken = (blocker.address() as { port: number }).port;
        const written: { port: number; token: string }[] = [];
        const mcp = genieMcpServer({ registrations: [], remember: { read: () => ({ port: taken, token: 'remembered-token-0123456789abcdef' }), write: (v) => { written.push(v); } } });
        started.push(mcp);
        const e = await mcp.start();
        expect(portOf(e.url)).not.toBe(taken);
        expect(e.token).toBe('remembered-token-0123456789abcdef');
        expect(written).toEqual([{ port: portOf(e.url), token: 'remembered-token-0123456789abcdef' }]);
        expect(await mcp.verify()).toMatchObject({ ok: true });
    });
});
