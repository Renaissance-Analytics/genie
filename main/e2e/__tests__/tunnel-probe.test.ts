import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { TUNNEL_PROBE_SCRIPT } from '../tunnel-probe';
import { pendingTunnelLegs, type TunnelProbeShape } from '../tunnel-legs';

/**
 * The fixture probe's CONVERGENCE (genie#80).
 *
 * The flake was a one-shot probe: every capability got exactly one attempt, at
 * the earliest instant of app boot, and the page then declared itself ready
 * regardless of the result. A leg that lost the warm-up race — the first CONNECT
 * and first session leaf for a brand-new origin, while the main process is still
 * finishing boot — was frozen false for the whole run, and the spec asserted on
 * that sample. CI hit it as `absoluteStyle: false` (twice) and `reverb: false`.
 *
 * These drive the REAL probe source against stubbed browser globals, with a leg
 * scripted to fail its first attempt, and run the same loop the main process
 * runs (`pendingTunnelLegs` → `__tunnelRun(pending)`). One deliberate
 * adaptation: ESM `import()` cannot be intercepted in a plain `vm` context, so
 * the source calls `loadModule`, which the page binds to a real dynamic import
 * and this harness binds to a stub. Everything else is the shipped code.
 */

interface Harness {
    probe: TunnelProbeShape;
    /** Run one convergence step the way the main-process poll does; resolves
     *  with the legs still outstanding afterwards. */
    step(): Promise<string[]>;
    /** How many times each leg was attempted. */
    attempts: Record<string, number>;
    /** Every URL the page requested, in order (so a retry's cache-bust shows). */
    urls: string[];
}

/** Build a stubbed browser around the probe. `failing` maps a leg-ish resource
 *  to the number of leading attempts that should fail. */
function harness(failing: Record<string, number> = {}): Harness {
    const attempts: Record<string, number> = {};
    const urls: string[] = [];
    let styleApplied = false;

    /** Count an attempt against a resource key and decide whether it fails. */
    const shouldFail = (key: string): boolean => {
        attempts[key] = (attempts[key] ?? 0) + 1;
        return attempts[key] <= (failing[key] ?? 0);
    };

    const jsonFor = (url: string): unknown => {
        if (url.includes('/api/bearer')) {
            return { ok: true, authorization: 'Bearer fixture-application-token' };
        }
        if (url.includes('/api/cookie-check')) return { ok: true };
        if (url.includes('/api/cookie')) return { ok: true };
        if (url.includes('/redirect')) return { ok: true };
        if (url.includes('manifest.json')) return { 'resources/js/app.ts': { isEntry: true } };
        if (url.includes('@vite/client.map')) return { sources: ['/@vite/client'] };
        if (url.includes('app.js.map')) return { sources: ['webpack://app/page.tsx'] };
        return {};
    };

    const context: Record<string, unknown> = {
        window: {} as Record<string, unknown>,
        location: { origin: 'https://app.gen', host: 'app.gen' },
        setTimeout,
        clearTimeout,
        Promise,
        JSON,
        String,
        Error,
        Object,
        console,
    };
    const win = context.window as Record<string, unknown>;

    context.getComputedStyle = () => ({ color: styleApplied ? 'rgb(1, 2, 3)' : 'rgb(0, 0, 0)' });
    context.document = {
        getElementById: () => ({}),
        head: {
            // The injected <script>/<link> resolves on the next turn, load or error.
            appendChild: (el: { src?: string; href?: string; onload(): void; onerror(): void }) => {
                const url = el.src ?? el.href ?? '';
                urls.push(url);
                const key = url.includes('absolute.js') ? 'absolute.js' : 'absolute.css';
                setTimeout(() => {
                    if (shouldFail(key)) {
                        el.onerror();
                        return;
                    }
                    if (key === 'absolute.js') win.__absoluteScriptLoaded = true;
                    else styleApplied = true;
                    el.onload();
                }, 0);
            },
        },
        createElement: (tag: string) => ({ tag, onload: () => {}, onerror: () => {} }),
    };

    context.fetch = async (url: string) => {
        urls.push(url);
        if (shouldFail(url.split('?')[0])) throw new Error('fetch failed');
        return { url, json: async () => jsonFor(url) };
    };

    context.loadModule = async (url: string) => {
        urls.push(url);
        if (shouldFail(url.split('?')[0])) throw new Error('module failed');
        if (url.includes('@vite/client')) win.__viteClientLoaded = true;
        else win.__nextDevChunkLoaded = true;
        return {};
    };

    const messageFor = (url: string): string | undefined => {
        if (url.endsWith('/ws')) return 'ws-ok';
        if (url.includes('/hmr')) return JSON.stringify({ type: 'connected' });
        if (url.includes('webpack-hmr')) return JSON.stringify({ action: 'sync' });
        if (url.includes('/app/')) {
            return JSON.stringify({ event: 'pusher:connection_established' });
        }
        return undefined;
    };

    class StubWebSocket {
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(url: string) {
            urls.push(url);
            setTimeout(() => {
                if (shouldFail(url.split('?')[0])) {
                    this.onerror?.();
                    return;
                }
                const data = messageFor(url);
                if (data !== undefined) this.onmessage?.({ data });
            }, 0);
        }
        close(): void {}
    }
    context.WebSocket = StubWebSocket;

    class StubEventSource {
        private listeners: Record<string, (event: { data: string }) => void> = {};
        onerror: (() => void) | null = null;
        constructor(url: string) {
            urls.push(url);
            setTimeout(() => {
                if (shouldFail(url.split('?')[0])) {
                    this.onerror?.();
                    return;
                }
                this.listeners.fixture?.({ data: 'stream-ok' });
            }, 0);
        }
        addEventListener(name: string, fn: (event: { data: string }) => void): void {
            this.listeners[name] = fn;
        }
        close(): void {}
    }
    context.EventSource = StubEventSource;

    vm.createContext(context);
    vm.runInContext(TUNNEL_PROBE_SCRIPT, context);

    const probe = win.__tunnelProbe as TunnelProbeShape;
    // The CDP leg is main-side; the page never sets it. Grant it so these tests
    // exercise the page's own convergence (tunnel-legs.test.ts covers the flag).
    probe.vite.debugger = true;

    const settle = async () => {
        // Let the stubbed resources resolve and the pass finish.
        for (let i = 0; i < 50 && probe.running; i++) {
            await new Promise((r) => setTimeout(r, 1));
        }
    };

    return {
        probe,
        attempts,
        urls,
        async step() {
            await settle();
            const pending = pendingTunnelLegs(probe).filter((leg) => leg !== 'debugger');
            if (pending.length) {
                await (win.__tunnelRun as (names: string[]) => Promise<void>)(pending);
                await settle();
            }
            return pendingTunnelLegs(probe).filter((leg) => leg !== 'debugger');
        },
    };
}

describe('tunnel fixture probe', () => {
    it('reaches a fully green state on a healthy tunnel in one pass', async () => {
        const h = harness();
        expect(await h.step()).toEqual([]);
        expect(h.probe.errors).toEqual([]);
        expect(h.probe.recovered).toEqual([]);
        expect(h.probe.running).toBe(false);
        expect(h.probe.absoluteStyle).toBe(true);
        expect(h.probe.reverb).toBe(true);
    });

    it('recovers the reverb socket that failed its first attempt', async () => {
        // The exact CI failure: `reverb: false` + `errors: ["reverb: Error: failed"]`.
        const h = harness({ 'wss://ws.app.test/app/e2e-key': 1 });
        await h.step();
        // Before the fix this state was published as ready and asserted on.
        expect(await h.step()).toEqual([]);
        expect(h.probe.reverb).toBe(true);
        expect(h.probe.errors).toEqual([]);
        expect(h.probe.recovered).toEqual(['reverb']);
    });

    it('recovers the stylesheet subresource that failed its first attempt', async () => {
        // The other CI failure: `absoluteStyle: false`. Polling could never fix
        // it — a classic script blocks on pending stylesheets, so by the time the
        // probe ran the sheet had already loaded or failed. Only a re-request can.
        const h = harness({ 'absolute.css': 1 });
        await h.step();
        expect(await h.step()).toEqual([]);
        expect(h.probe.absoluteStyle).toBe(true);
        expect(h.probe.recovered).toEqual(['absoluteStyle']);
        // The retry must not replay the browser's cached failure.
        expect(h.urls.filter((u) => u.includes('absolute.css')).at(-1)).toContain('pass=');
    });

    it('re-runs ONLY the outstanding legs, never the ones already working', async () => {
        const h = harness({ 'wss://ws.app.test/app/e2e-key': 1 });
        await h.step();
        await h.step();
        // One bearer fetch total: a green leg is never paid for twice.
        expect(h.attempts['/api/bearer']).toBe(1);
        expect(h.attempts['wss://ws.app.test/app/e2e-key']).toBe(2);
    });

    it('keeps reporting a leg that stays broken instead of going quietly green', async () => {
        // The assertion must still FAIL for a genuinely broken tunnel: retries
        // converge a warm-up race, they do not paper over a dead leg.
        const h = harness({ 'wss://ws.app.test/app/e2e-key': 99 });
        await h.step();
        expect(await h.step()).toEqual(['reverb']);
        expect(h.probe.reverb).toBe(false);
        expect(h.probe.errors).toEqual(['reverb: Error: failed']);
    });

    it('clears a recovered leg error while keeping a still-failing one', async () => {
        const h = harness({ 'absolute.css': 1, 'wss://ws.app.test/app/e2e-key': 99 });
        await h.step();
        await h.step();
        expect(h.probe.absoluteStyle).toBe(true);
        // `errors` is the LAST pass only, so the recovered leg's error is gone
        // and `errors: []` in the spec stays a meaningful assertion.
        expect(h.probe.errors).toEqual(['reverb: Error: failed']);
        expect(h.probe.recovered.sort()).toEqual(['absoluteStyle', 'reverb']);
    });
});
