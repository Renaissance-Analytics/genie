import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PtyOpened, PtyPort } from '../src/main/terminal-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager, type CreateSiteInput, type SiteManagerDeps } from '../src/main/site-manager.js';
import { SITE_READY_TIMEOUT_MS } from '../src/main/port-probe.js';

/**
 * A SLOW START IS NOT A FAILURE (genie#1393).
 *
 * After a Genie restart every hosted site on the owner's machine read red "failed" and was unrouted, and so unreachable at
 * https://<name>.gen, while each answered on its own port in under a second. About ten PHP sites (a Caddy and four php-cgi
 * workers each) started in the same instant at boot, missed the ONE 15 s probe #1355 gave them, and nothing ever asked
 * again until someone clicked Retry. Genie 1 (v0.7.0-beta.342) never had this. Its `ready` was a flag on a site that
 * stayed live and routed either way, and `refresh()` asked again on every status (genie#305).
 */

/** A pty whose processes the test can end: `exit(ptyId, code)`. */
function exitablePty() {
    let n = 0;
    const exits: Array<(id: string, code: number) => void> = [];
    const port: PtyPort = {
        open(options) { const id = `term_${++n}`; return { id, pid: 3000 + n, shell: options.command ?? 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: () => () => {},
        onExit: (fn) => { exits.push(fn as (id: string, code: number) => void); return () => {}; },
    };
    return { port, exit: (ptyId: string, code: number) => { for (const fn of exits) fn(ptyId, code); } };
}

/** A probe the test answers by hand: each call is held until `answer(i, ok)`. */
function heldProbe() {
    const calls: Array<{ port: number; behindCaddy: boolean; resolve: (ok: boolean) => void }> = [];
    const probe: NonNullable<SiteManagerDeps['probeReady']> = (port, options) => new Promise<boolean>((resolve) => { calls.push({ port, behindCaddy: options.behindCaddy, resolve }); });
    return { calls, probe, answer: async (i: number, ok: boolean) => { calls[i]!.resolve(ok); await settle(); } };
}

/** A clock and a sleep the test moves: each `sleep` is held until `tick()`, which moves the clock by its length. */
function manualTime() {
    let now = 0;
    const sleeps: Array<{ ms: number; resolve: () => void }> = [];
    const asked: number[] = [];
    return {
        now: () => now,
        sleep: (ms: number) => new Promise<void>((resolve) => { asked.push(ms); sleeps.push({ ms, resolve }); }),
        sleeps,
        asked,
        async tick() {
            const s = sleeps.shift();
            if (!s) throw new Error('nothing is sleeping');
            now += s.ms;
            s.resolve();
            await settle();
        },
        advance(ms: number) { now += ms; },
    };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function make(over: Partial<SiteManagerDeps> = {}, schedule: (fn: () => void) => () => void = () => () => {}) {
    const pty = exitablePty();
    const supervisor = new ProcessSupervisor(pty.port, { now: () => 0, schedule: (fn) => schedule(fn) });
    let next = 4100;
    const sites = new SiteManager({ supervisor, allocatePort: () => ++next, caddyBin: '/opt/caddy', configDir: '/data/sites', writeConfig: () => {}, phpWorkers: 1, ...over });
    let changes = 0;
    sites.onChange(() => { changes++; });
    return { sites, supervisor, pty, changes: () => changes };
}
const proxy: CreateSiteInput = { name: 'web', workspaceId: 'acme', repoPath: '/repos/acme', serve: { mode: 'proxy' as const }, devServer: { stack: 'node', command: 'npm run dev -- --port {port}' } };

describe('a slow start is not a failure (genie#1393)', () => {
    it('a first probe that misses reads "starting" (slow), not failed, and Genie ASKS AGAIN; the answer makes it running AND routed with no click', async () => {
        const p = heldProbe();
        const t = manualTime();
        const { sites, changes } = make({ probeReady: p.probe, sleep: t.sleep, now: t.now });
        const site = sites.create(proxy);
        expect(sites.get(site.id)!.step).toBe('answering');
        t.advance(SITE_READY_TIMEOUT_MS);
        await p.answer(0, false);
        const slow = sites.get(site.id)!;
        expect(slow.state).toBe('starting');
        expect(slow.step).toBe('slow');
        expect(slow.problem).toBeNull();
        expect(sites.routes()).toEqual([]);
        await t.tick();
        expect(p.calls).toHaveLength(2);
        const before = changes();
        await p.answer(1, true);
        const up = sites.get(site.id)!;
        expect(up.state).toBe('running');
        expect(up.step).toBeUndefined();
        expect(up.problem).toBeNull();
        expect(sites.routes()).toEqual([{ host: 'web.gen', target: `127.0.0.1:${site.port}` }]);
        expect(changes()).toBeGreaterThan(before);
    });

    it('asks again with BACKOFF: each gap at least as long as the last, and capped (never a tight loop, never minutes of silence)', async () => {
        const p = heldProbe();
        const t = manualTime();
        const { sites } = make({ probeReady: p.probe, sleep: t.sleep, now: t.now });
        sites.create(proxy);
        for (let i = 0; i < 10; i++) {
            await p.answer(i, false);
            await t.tick();
        }
        expect(p.calls).toHaveLength(11);
        expect(t.asked[0]).toBeGreaterThanOrEqual(500);
        for (let i = 1; i < t.asked.length; i++) expect(t.asked[i]).toBeGreaterThanOrEqual(t.asked[i - 1]!);
        expect(Math.max(...t.asked)).toBeLessThanOrEqual(30_000);
    });

    it('failed only past the CEILING with no answer: the reason names it, Genie keeps asking, and a later answer still recovers it', async () => {
        const p = heldProbe();
        const t = manualTime();
        const { sites } = make({ probeReady: p.probe, sleep: t.sleep, now: t.now, readyCeilingMs: 180_000 });
        const site = sites.create(proxy);
        await p.answer(0, false);
        expect(sites.get(site.id)!.state).toBe('starting');
        t.advance(180_000);
        await t.tick();
        await p.answer(1, false);
        const failed = sites.get(site.id)!;
        expect(failed.state).toBe('failed');
        expect(failed.problem).toContain(`web.gen did not answer on 127.0.0.1:${site.port} within 3 min`);
        expect(failed.problem).toMatch(/process is running/);
        expect(failed.problem).toMatch(/still asking/);
        expect(sites.routes()).toEqual([]);
        await t.tick();
        expect(p.calls).toHaveLength(3);
        await p.answer(2, true);
        expect(sites.get(site.id)!.state).toBe('running');
        expect(sites.get(site.id)!.problem).toBeNull();
        expect(sites.routes()).toEqual([{ host: 'web.gen', target: `127.0.0.1:${site.port}` }]);
    });

    it('a stop while Genie is still asking ends the asking: no probe after it, and it stays stopped', async () => {
        const p = heldProbe();
        const t = manualTime();
        const { sites } = make({ probeReady: p.probe, sleep: t.sleep, now: t.now });
        const site = sites.create(proxy);
        await p.answer(0, false);
        sites.stop(site.id);
        await t.tick();
        expect(p.calls).toHaveLength(1);
        expect(sites.get(site.id)!.state).toBe('stopped');
    });

    it('Genie gives a site 3 minutes by default before it reads failed (SITE_READY_CEILING_MS)', async () => {
        const mod = await import('../src/main/port-probe.js');
        expect((mod as unknown as { SITE_READY_CEILING_MS: number }).SITE_READY_CEILING_MS).toBe(180_000);
    });
});

describe('the reason tells the truth about the process (genie#1393, consensus.prism.gen)', () => {
    it('a dev server that EXITED while Genie waited never reads "its process is running": it says it exited, with the code', async () => {
        const p = heldProbe();
        const t = manualTime();
        const { sites, pty } = make({ probeReady: p.probe, sleep: t.sleep, now: t.now });
        const site = sites.create({ ...proxy, devServer: { stack: 'node', command: 'npm start' } });
        // restart: on-failure, so a clean exit (0) is not restarted and the process is gone for good.
        pty.exit('term_1', 0);
        await p.answer(0, false);
        const after = sites.get(site.id)!;
        expect(after.state).toBe('exited');
        expect(after.problem ?? '').not.toMatch(/process is running/);
        expect(after.problem).toContain('web.gen dev server exited with code 0');
        expect(t.sleeps).toHaveLength(0);
    });

    it('a dev server the supervisor GAVE UP on says so in the supervisor\'s words, and Genie stops asking', async () => {
        const p = heldProbe();
        const t = manualTime();
        const scheduled: Array<() => void> = [];
        const { sites, supervisor, pty } = make({ probeReady: p.probe, sleep: t.sleep, now: t.now }, (fn) => { scheduled.push(fn); return () => {}; });
        const site = sites.create(proxy);
        // Crash it until the supervisor gives up (each restart opens the next pty id).
        for (let i = 1; i < 20 && supervisor.status(site.processIds[0]!)?.state !== 'failed'; i++) {
            pty.exit(`term_${i}`, 1);
            scheduled.shift()?.();
        }
        expect(supervisor.status(site.processIds[0]!)?.state).toBe('failed');
        await p.answer(0, false);
        const after = sites.get(site.id)!;
        expect(after.state).toBe('failed');
        expect(after.problem).toMatch(/gave up after/);
        expect(after.problem ?? '').not.toMatch(/process is running/);
        expect(t.sleeps).toHaveLength(0);
    });
});

describe('a double click joins the restart in flight (genie#1393; the owner: "I almost did" spam it)', () => {
    it('restart({ join }) while the start is still in its first answer window changes nothing: same port, no second start, no second probe', async () => {
        const p = heldProbe();
        const t = manualTime();
        const { sites } = make({ probeReady: p.probe, sleep: t.sleep, now: t.now });
        const site = sites.create(proxy);
        await p.answer(0, true);
        expect(sites.get(site.id)!.state).toBe('running');
        const first = sites.restart(site.id, { join: true });
        expect(first.port).not.toBe(site.port); // the first click DID restart a site that was answering (positive control)
        expect(p.calls).toHaveLength(2);
        const second = sites.restart(site.id, { join: true });
        expect(p.calls).toHaveLength(2);
        expect(second.port).toBe(first.port);
        expect(second.state).toBe('starting');
    });

    it('but a Retry on a site past its first window (slow) really restarts it, on a fresh port', async () => {
        const p = heldProbe();
        const t = manualTime();
        const { sites } = make({ probeReady: p.probe, sleep: t.sleep, now: t.now });
        const site = sites.create(proxy);
        await p.answer(0, false);
        expect(sites.get(site.id)!.step).toBe('slow');
        const again = sites.restart(site.id, { join: true });
        expect(again.port).not.toBe(site.port);
        expect(p.calls).toHaveLength(2);
    });

    it('a restart without join (a toolchain update) always restarts', () => {
        const p = heldProbe();
        const { sites } = make({ probeReady: p.probe });
        const site = sites.create(proxy);
        expect(sites.restart(site.id).port).not.toBe(site.port);
    });

    it('the person\'s and an agent\'s Restart (envelope-sites-host) join', () => {
        const src = readFileSync(new URL('../src/main/envelope-sites-host.ts', import.meta.url), 'utf8');
        expect(src).toContain('this.#sites.restart(siteId, { join: true })');
    });
});
