import { describe, expect, it, vi } from 'vitest';
import { createTynnHealthService } from '../tynn-health-service';
import type { HttpObservation, TynnHealth, TynnProbeHttp } from '../tynn-health';

const WS = { workspaceId: 'ws1', workspacePath: 'C:/proj/tynn.ai', workspaceName: 'tynn.ai' };

function json(status: number, body: unknown): HttpObservation {
    return { kind: 'response', status, headers: {}, bodyText: JSON.stringify(body) };
}
const INIT = json(200, { jsonrpc: '2.0', id: 1, result: {} });
const TOOLS = json(200, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'project' }] } });

/** An http seam that counts calls and can be held open until released. */
function controllableHttp() {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const post = vi.fn(async (_url: string, _h: Record<string, string>, body: string) => {
        await gate;
        return JSON.parse(body).method === 'initialize' ? INIT : TOOLS;
    });
    return { http: { post } as TynnProbeHttp, post, release: () => release?.() };
}

function deps(over: Partial<Parameters<typeof createTynnHealthService>[0]> = {}) {
    return {
        readUrl: () => 'https://tynn.ai/mcp/tynn',
        readToken: () => 'tok',
        http: { post: async () => TOOLS } as TynnProbeHttp,
        ...over,
    };
}

describe('createTynnHealthService', () => {
    it('reads the url and token from the workspace path it was given', async () => {
        const readUrl = vi.fn(() => 'https://tynn.ai/mcp/tynn');
        const readToken = vi.fn(() => 'tok');
        const http: TynnProbeHttp = {
            post: async (_u, _h, body) => (JSON.parse(body).method === 'initialize' ? INIT : TOOLS),
        };
        const service = createTynnHealthService(deps({ readUrl, readToken, http }));

        const health = await service.check(WS);

        expect(readUrl).toHaveBeenCalledWith('C:/proj/tynn.ai');
        expect(readToken).toHaveBeenCalledWith('C:/proj/tynn.ai');
        expect(health.state).toBe('healthy');
        expect(health.workspaceId).toBe('ws1');
    });

    it('SINGLE-FLIGHTS concurrent checks — the endpoint is production, not a load target', async () => {
        const { http, post, release } = controllableHttp();
        const service = createTynnHealthService(deps({ http }));

        const both = Promise.all([service.check(WS), service.check(WS)]);
        release();
        const [a, b] = await both;

        // Two HTTP calls total (initialize + tools/list), not four.
        expect(post).toHaveBeenCalledTimes(2);
        expect(a).toBe(b);
    });

    it('lets a LATER check re-probe once the first has settled', async () => {
        const post = vi.fn(async (_u: string, _h: Record<string, string>, body: string) =>
            JSON.parse(body).method === 'initialize' ? INIT : TOOLS,
        );
        const service = createTynnHealthService(deps({ http: { post } as TynnProbeHttp }));

        await service.check(WS);
        await service.check(WS);

        expect(post).toHaveBeenCalledTimes(4);
    });

    it('pushes each result to onResult so the renderer never has to poll', async () => {
        const onResult = vi.fn();
        const http: TynnProbeHttp = {
            post: async (_u, _h, body) => (JSON.parse(body).method === 'initialize' ? INIT : TOOLS),
        };
        const service = createTynnHealthService(deps({ http, onResult }));

        const health = await service.check(WS);

        expect(onResult).toHaveBeenCalledTimes(1);
        expect((onResult.mock.calls[0][0] as TynnHealth).workspaceId).toBe('ws1');
        expect(onResult.mock.calls[0][0]).toEqual(health);
    });

    it('caches the last result per workspace, and knows nothing before the first check', async () => {
        const http: TynnProbeHttp = {
            post: async (_u, _h, body) => (JSON.parse(body).method === 'initialize' ? INIT : TOOLS),
        };
        const service = createTynnHealthService(deps({ http }));

        expect(service.cached('ws1')).toBeNull();
        const health = await service.check(WS);
        expect(service.cached('ws1')).toEqual(health);
        expect(service.all()).toEqual({ ws1: health });
    });

    it('never throws when reading the workspace config blows up', async () => {
        const service = createTynnHealthService(
            deps({
                readUrl: () => {
                    throw new Error('EPERM: .mcp.json is locked');
                },
            }),
        );

        const health = await service.check(WS);

        expect(health.state).toBe('unconfigured');
        expect(health.url).toBeNull();
    });

    it('never throws when onResult itself blows up — a listener must not break the probe', async () => {
        const http: TynnProbeHttp = {
            post: async (_u, _h, body) => (JSON.parse(body).method === 'initialize' ? INIT : TOOLS),
        };
        const service = createTynnHealthService(
            deps({
                http,
                onResult: () => {
                    throw new Error('window destroyed');
                },
            }),
        );

        await expect(service.check(WS)).resolves.toMatchObject({ state: 'healthy' });
    });

    it('forgets a workspace on demand, so a removed workspace leaves no stale tint', async () => {
        const http: TynnProbeHttp = {
            post: async (_u, _h, body) => (JSON.parse(body).method === 'initialize' ? INIT : TOOLS),
        };
        const service = createTynnHealthService(deps({ http }));

        await service.check(WS);
        service.forget('ws1');

        expect(service.cached('ws1')).toBeNull();
        expect(service.all()).toEqual({});
    });
});
