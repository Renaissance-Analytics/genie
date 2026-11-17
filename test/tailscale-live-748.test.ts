import { describe, expect, it } from 'vitest';
import type { TailscaleState, TailscaleStatus, TailscaleUpResult } from '../src/main/tailscale-cli.js';
import { tailscaleLive, type InstallAnswer, type TailscaleLivePorts } from '../src/main/tailscale-live.js';

/**
 * TAILSCALE, LIVE (Tynn #748, #749; the LiftPoint onboarding, 2026-11-16). On the client's Windows laptop:
 *  - #748: Settings → Remote access → Install Tailscale started the installer TWICE. After the first installer opened, Genie
 *    read Tailscale once (still absent) and kept offering the same Install button, unchanged, with nothing to say a click
 *    had been taken, so the next click downloaded and opened a second installer.
 *  - #749: Tailscale came up and Genie never noticed: it read Tailscale at boot, right after a click, and never again, so
 *    only a full shutdown and relaunch showed "Tailscale connected".
 * Genie now owns one live view of Tailscale: one installer per click run, a re-read on its own (bounded) while it waits
 * for Tailscale to be installed and signed in, and remote access applied the moment Tailscale is connected.
 */

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** A clock and timers the test advances. */
function clock() {
    let t = 0;
    let id = 0;
    const queue: { at: number; fn: () => void; id: number }[] = [];
    return {
        now: () => t,
        timers: {
            set: (fn: () => void, ms: number): unknown => { queue.push({ at: t + ms, fn, id: ++id }); return id; },
            clear: (handle: unknown): void => { const i = queue.findIndex((q) => q.id === handle); if (i >= 0) queue.splice(i, 1); },
        },
        async advance(ms: number): Promise<void> {
            const end = t + ms;
            for (;;) {
                queue.sort((a, b) => a.at - b.at);
                const next = queue[0];
                if (!next || next.at > end) break;
                queue.shift();
                t = next.at;
                next.fn();
                await flush();
            }
            t = end;
            await flush();
        },
    };
}

const status = (state: TailscaleState): TailscaleStatus => ({
    installed: state !== 'absent', running: state === 'running', state, peers: [], remedy: null,
    self: state === 'running' ? { ip: '100.64.0.9', hostname: 'laptop', online: true, dnsName: 'laptop.tail0000.ts.net' } : null,
});

/** Probes that answer these states in turn (the last one repeats), counted. */
function probes(...states: TailscaleState[]) {
    let n = 0;
    return { count: () => n, probe: async () => status(states[Math.min(n++, states.length - 1)]!) };
}

function rig(over: Partial<TailscaleLivePorts> & { states?: TailscaleState[] } = {}) {
    const c = clock();
    const p = probes(...(over.states ?? ['absent']));
    let installs = 0;
    let onlines = 0;
    let changes = 0;
    const live = tailscaleLive({
        probe: p.probe,
        install: async () => { installs++; return { started: true }; },
        up: async () => ({ ok: true, state: 'running' }),
        online: async () => { onlines++; },
        changed: () => { changes++; },
        timers: c.timers, now: c.now, everyMs: 3_000, forMs: 60_000,
        ...over,
    });
    return { live, clock: c, probes: p, installs: () => installs, onlines: () => onlines, changes: () => changes };
}

describe('Install Tailscale: one installer per install (Tynn #748)', () => {
    it('two clicks while the first is still downloading start ONE installer, and both are answered', async () => {
        let release!: (a: InstallAnswer) => void;
        let installs = 0;
        const r = rig({ install: () => { installs++; return new Promise<InstallAnswer>((resolve) => { release = resolve; }); } });
        const first = r.live.install();
        const second = r.live.install();
        await flush();
        release({ started: true });
        expect(await first).toEqual({ started: true });
        expect((await second).started).toBe(true);
        expect(installs).toBe(1);
    });

    it('a click after the installer opened, Tailscale still not there, starts nothing and says the installer is open', async () => {
        const r = rig();
        await r.live.refresh();
        expect((await r.live.install()).started).toBe(true);
        const again = await r.live.install();
        expect(again.started).toBe(false);
        expect(again.message).toMatch(/installer is already open/i);
        expect(r.installs()).toBe(1);
    });

    it('the status says Install is under way from the click until Tailscale is there, and then no longer', async () => {
        const r = rig({ states: ['absent', 'absent', 'needs-login'] });
        await r.live.refresh();
        expect(r.live.status()?.installing ?? false).toBe(false);
        await r.live.install();
        expect(r.live.status()?.installing).toBe(true);
        await r.clock.advance(6_000);
        expect(r.live.status()?.state).toBe('needs-login');
        expect(r.live.status()?.installing ?? false).toBe(false);
    });

    it('CONTROL: an Install that only opened the download page locks nothing: the next click tries again', async () => {
        let installs = 0;
        const r = rig({ install: async () => { installs++; return { started: false, url: 'https://tailscale.com/download' }; } });
        await r.live.install();
        await r.live.install();
        expect(installs).toBe(2);
    });
});

describe('Tailscale is noticed live, never only after a relaunch (Tynn #749)', () => {
    it('after the installer opens Genie reads Tailscale on its own through install and sign-in, and applies remote access once it is connected', async () => {
        const r = rig({ states: ['absent', 'absent', 'needs-login', 'running'] });
        await r.live.refresh();
        await r.live.install();
        await r.clock.advance(9_000);
        expect(r.live.status()?.state).toBe('running');
        expect(r.onlines()).toBe(1);
    });

    it('the reading stops once Tailscale is connected', async () => {
        const r = rig({ states: ['absent', 'needs-login', 'running'] });
        await r.live.refresh();
        await r.live.install();
        await r.clock.advance(6_000);
        const seen = r.probes.count();
        await r.clock.advance(30_000);
        expect(seen).toBe(3);
        expect(r.probes.count()).toBe(seen);
    });

    it('the reading is bounded: an installer left unfinished stops being waited for, and Install starts one again', async () => {
        const r = rig({ states: ['absent'] });
        await r.live.refresh();
        await r.live.install();
        await r.clock.advance(61_000);
        const seen = r.probes.count();
        expect(seen).toBeGreaterThan(2);
        await r.clock.advance(60_000);
        expect(r.probes.count()).toBe(seen);
        expect(r.live.status()?.installing ?? false).toBe(false);
        expect((await r.live.install()).started).toBe(true);
        expect(r.installs()).toBe(2);
    });

    it('a read that finds Tailscale newly connected applies remote access, once', async () => {
        const r = rig({ states: ['needs-login', 'running'] });
        await r.live.refresh();
        await r.live.refresh();
        await r.live.refresh();
        expect(r.onlines()).toBe(1);
    });

    it('CONTROL: a read that finds Tailscale not connected applies nothing', async () => {
        const r = rig({ states: ['needs-login'] });
        await r.live.refresh();
        await r.live.refresh();
        expect(r.onlines()).toBe(0);
    });

    it('Remote access opened while Tailscale is not connected: Genie keeps reading until it is (the person signs in in Tailscale’s own window)', async () => {
        const r = rig({ states: ['needs-login', 'needs-login', 'running'] });
        await r.live.look();
        await r.clock.advance(6_000);
        expect(r.live.status()?.state).toBe('running');
        expect(r.onlines()).toBe(1);
    });

    it('Connect that hands back a sign-in link keeps reading until the sign-in completes', async () => {
        const r = rig({ states: ['needs-login', 'needs-login', 'running'], up: async () => ({ ok: false, state: 'needs-login', authUrl: 'https://login.tailscale.com/a/x' }) });
        await r.live.up();
        await r.clock.advance(6_000);
        expect(r.live.status()?.state).toBe('running');
        expect(r.onlines()).toBe(1);
    });

    it('reads that find nothing new push nothing: a wait on an unchanged Tailscale costs the windows no snapshot every 3 s', async () => {
        const r = rig({ states: ['needs-login'] });
        await r.live.look();
        await r.clock.advance(30_000);
        expect(r.probes.count()).toBeGreaterThan(5);
        expect(r.changes()).toBe(1);
    });

    it('CONTROL: a read that finds Tailscale changed pushes it', async () => {
        const r = rig({ states: ['needs-login', 'running'] });
        await r.live.refresh();
        await r.live.refresh();
        expect(r.changes()).toBe(2);
    });

    it('CONTROL: Connect’s answer reaches the window unchanged', async () => {
        const answer: TailscaleUpResult = { ok: false, state: 'needs-login', authUrl: 'https://login.tailscale.com/a/y', message: 'Tailscale needs you to log in.' };
        const r = rig({ states: ['needs-login'], up: async () => answer });
        expect(await r.live.up()).toBe(answer);
    });
});
