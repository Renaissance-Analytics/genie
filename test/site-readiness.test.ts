import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { PtyOpened, PtyPort } from '../src/main/terminal-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager, type CreateSiteInput, type SiteManagerDeps } from '../src/main/site-manager.js';
import { siteAnswers, SITE_READY_TIMEOUT_MS } from '../src/main/port-probe.js';
import { siteTone } from '../src/core/rail-indicators.js';

/**
 * A SITE READS "RUNNING" ONLY ONCE ITS PORT ANSWERS (parity audit 2026-10-30, top-15 #9).
 *
 * Genie 2 derived a site's state from its main process being alive, so the moment `npm run dev` was spawned the site
 * read "running" — to the person, to the front door's routes, and to an agent's `sites` call — while the dev server was
 * still compiling. Genie 1 (v0.7.0-beta.342) waited: `main/dev-server/site-manager.ts:1005-1013` probed the site's port
 * (`main/dev-server/port-probe.ts` `waitForHttp`, 15 s `DEFAULT_READY_TIMEOUT_MS`) before calling it ready; behind its
 * own Caddy a 502/503/504 meant "not bound yet" (`waitForHttpsSni`).
 */

function fakePty(): PtyPort {
    let n = 0;
    return {
        open(options) { const id = `term_${++n}`; return { id, pid: 2000 + n, shell: options.command ?? 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: () => () => {},
        onExit: () => () => {},
    };
}

/** A probe the test answers by hand: each call is held until `answer(i, ok)`. */
function heldProbe() {
    const calls: Array<{ port: number; behindCaddy: boolean; resolve: (ok: boolean) => void }> = [];
    const probe: NonNullable<SiteManagerDeps['probeReady']> = (port, options) => new Promise<boolean>((resolve) => { calls.push({ port, behindCaddy: options.behindCaddy, resolve }); });
    return { calls, probe, answer: async (i: number, ok: boolean) => { calls[i]!.resolve(ok); await new Promise((r) => setTimeout(r, 0)); } };
}

function make(over: Partial<SiteManagerDeps> = {}) {
    const supervisor = new ProcessSupervisor(fakePty(), { now: () => 0, schedule: () => () => {} });
    let next = 4100;
    const sites = new SiteManager({ supervisor, allocatePort: () => ++next, caddyBin: '/opt/caddy', configDir: '/data/sites', writeConfig: () => {}, phpWorkers: 1, ...over });
    let changes = 0;
    sites.onChange(() => { changes++; });
    return { sites, supervisor, changes: () => changes };
}
const proxy: CreateSiteInput = { name: 'web', workspaceId: 'acme', repoPath: '/repos/acme', serve: { mode: 'proxy' as const }, devServer: { stack: 'node', command: 'npm run dev -- --port {port}' } };

describe('a started site waits for its port', () => {
    it('reads "starting" — and is not routed — until the port answers, then "running" and routed, with a change event', async () => {
        const p = heldProbe();
        const { sites, changes } = make({ probeReady: p.probe });
        const site = sites.create(proxy);
        expect(site.state).toBe('starting');
        expect(p.calls).toHaveLength(1);
        expect(p.calls[0]).toMatchObject({ port: site.port, behindCaddy: false });
        expect(sites.routes()).toEqual([]);
        const before = changes();
        await p.answer(0, true);
        expect(sites.get(site.id)!.state).toBe('running');
        expect(sites.routes()).toEqual([{ host: 'web.gen', target: `127.0.0.1:${site.port}` }]);
        expect(changes()).toBeGreaterThan(before);
    });

    it('a port that never answers within the timeout is "failed", with the reason (host, port, seconds)', async () => {
        const p = heldProbe();
        const { sites } = make({ probeReady: p.probe });
        const site = sites.create(proxy);
        await p.answer(0, false);
        const after = sites.get(site.id)!;
        expect(after.state).toBe('failed');
        expect(after.problem).toMatch(/web\.gen/);
        expect(after.problem).toMatch(new RegExp(`127\\.0\\.0\\.1:${site.port}`));
        expect(after.problem).toMatch(new RegExp(`${SITE_READY_TIMEOUT_MS / 1000} s`));
        expect(sites.routes()).toEqual([]);
    });

    it('Retry (a restart) waits again, and a late answer from the FIRST start does not mark the second one running', async () => {
        const p = heldProbe();
        const { sites } = make({ probeReady: p.probe });
        const site = sites.create(proxy);
        const again = sites.restart(site.id);
        expect(again.state).toBe('starting');
        expect(again.problem).toBeNull();
        expect(p.calls).toHaveLength(2);
        await p.answer(0, true); // the first start's probe, answering late
        expect(sites.get(site.id)!.state).toBe('starting');
        await p.answer(1, true);
        expect(sites.get(site.id)!.state).toBe('running');
    });

    it('a site stopped while it waits stays stopped when the answer comes', async () => {
        const p = heldProbe();
        const { sites } = make({ probeReady: p.probe });
        const site = sites.create(proxy);
        sites.stop(site.id);
        await p.answer(0, true);
        expect(sites.get(site.id)!.state).toBe('stopped');
        expect(sites.get(site.id)!.problem).toBeNull();
    });

    it('a Caddy-served site (static, php) is probed as such: a gateway error from Caddy is not the site', () => {
        const p = heldProbe();
        const { sites } = make({ probeReady: p.probe });
        sites.create({ name: 'docs', workspaceId: 'acme', repoPath: '/repos/acme', serve: { mode: 'static', root: 'public', spa: false } });
        expect(p.calls[0]!.behindCaddy).toBe(true);
    });

    it('a server you run yourself (hostPort) is not Genie\'s to wait for: "external" at once', () => {
        const p = heldProbe();
        const { sites } = make({ probeReady: p.probe });
        expect(sites.create({ ...proxy, devServer: undefined, hostPort: 3000 } as never).state).toBe('external');
        expect(p.calls).toHaveLength(0);
    });

    it('a dead dev server while waiting reads as its process does, not "starting"', async () => {
        const p = heldProbe();
        const { sites, supervisor } = make({ probeReady: p.probe });
        const site = sites.create(proxy);
        supervisor.stop(site.processIds[0]!);
        expect(sites.get(site.id)!.state).toBe('stopped');
    });

    it('the rail\'s site dot says "starting" for a site that is waiting', () => {
        expect(siteTone([{ workspaceId: 'acme', state: 'starting' }], 'acme')).toBe('starting');
    });

    it('Genie wires the real probe into its site manager (main.ts -> compose.ts -> SiteManager)', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        const compose = readFileSync(new URL('../src/main/compose.ts', import.meta.url), 'utf8');
        expect(main).toMatch(/composeServices\(\{[\s\S]{0,6000}?siteProbe: \(port, options\) => siteAnswers\(port, options\)/);
        expect(compose).toMatch(/new SiteManager\(\{[\s\S]{0,4000}?\.\.\.\(input\.siteProbe \? \{ probeReady: input\.siteProbe \} : \{\}\)/);
    });
});

describe('siteAnswers — the probe itself, on a real loopback socket (Genie 1 port-probe.ts waitForHttp)', () => {
    const servers: Server[] = [];
    afterEach(async () => {
        for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
    });
    const serve = async (status: number, delayMs = 0): Promise<number> => {
        const server = createServer((_q, res) => { res.statusCode = status; res.end('x'); });
        servers.push(server);
        const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
        if (delayMs > 0) {
            // Close it and listen again on the SAME port later: a dev server still binding.
            await new Promise((r) => server.close(r));
            setTimeout(() => server.listen(port, '127.0.0.1'), delayMs);
        }
        return port;
    };
    const freePort = async (): Promise<number> => {
        const s = createServer();
        const port = await new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port)));
        await new Promise((r) => s.close(r));
        return port;
    };

    it('POSITIVE CONTROL: a server answering 200 is ready', async () => {
        expect(await siteAnswers(await serve(200), { behindCaddy: false, timeoutMs: 2_000 })).toBe(true);
    });

    it('nothing listening: false once the budget is spent — not before, not much after', async () => {
        const port = await freePort();
        const t0 = Date.now();
        expect(await siteAnswers(port, { behindCaddy: false, timeoutMs: 800 })).toBe(false);
        const took = Date.now() - t0;
        expect(took).toBeGreaterThanOrEqual(500);
        expect(took).toBeLessThan(3_000);
    });

    it('a server that binds part-way through the wait is ready', async () => {
        expect(await siteAnswers(await serve(200, 400), { behindCaddy: false, timeoutMs: 3_000 })).toBe(true);
    });

    it('any status from a dev server counts (a framework\'s 403 or 500 is still a server); a 502 from Caddy does not', async () => {
        expect(await siteAnswers(await serve(500), { behindCaddy: false, timeoutMs: 1_000 })).toBe(true);
        expect(await siteAnswers(await serve(502), { behindCaddy: false, timeoutMs: 1_000 })).toBe(true);
        expect(await siteAnswers(await serve(502), { behindCaddy: true, timeoutMs: 800 })).toBe(false);
        expect(await siteAnswers(await serve(404), { behindCaddy: true, timeoutMs: 1_000 })).toBe(true);
    });
});
