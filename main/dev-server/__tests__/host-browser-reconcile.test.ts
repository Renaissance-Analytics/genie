import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostBrowserReconciler } from '../host-browser-reconcile';
import type { HostReconcilePlan, HostSiteRoute } from '../host-reconcile';

/**
 * The desktop trigger for the external-browser host reconcile (story #238 P3).
 * It owns three rules, and only these three — the reconcile BRAIN
 * (`reconcileHostSites`) owns the rest:
 *
 *   1. **Opt-in floor.** When NOTHING is browser-exposed, do nothing at all — no
 *      CA mint, no hosts edit, no Caddy. A machine that never opts a site in must
 *      never see an admin prompt.
 *   2. **Never throw.** It runs from boot and from a change event; a privileged
 *      step that fails is logged, not propagated.
 *   3. **Debounce.** `onChanged` fires on every site mutation; coalesce a burst
 *      into one reconcile.
 */
const route = (genName: string, port: number): HostSiteRoute => ({ genName, port });

/** Configured names == running routes: the shape these trigger tests describe,
 *  where the split of genie#624 is not what is under examination. */
const planOf = (routes: HostSiteRoute[]): HostReconcilePlan => ({
    names: routes.map((r) => r.genName),
    routes,
});

afterEach(() => vi.useRealTimers());

describe('createHostBrowserReconciler', () => {
    it('does NOTHING when no site is browser-exposed (no CA, no prompt)', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        const r = createHostBrowserReconciler({ plan: () => planOf([]), reconcile });
        await r.runNow();
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('reconciles to the current routes when at least one is exposed', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        const routes = [route('web.acme.gen', 8001)];
        const r = createHostBrowserReconciler({ plan: () => planOf(routes), reconcile });
        await r.runNow();
        expect(reconcile).toHaveBeenCalledWith(planOf(routes));
    });

    it('never throws when the (privileged) reconcile fails — it logs', async () => {
        const log = vi.fn();
        const reconcile = vi.fn().mockRejectedValue(new Error('trust store denied'));
        const r = createHostBrowserReconciler({ plan: () => planOf([route('a.gen', 1)]), reconcile, log });
        await expect(r.runNow()).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('trust store denied'));
    });

    it('DRAINS to empty once a site has been exposed — removing the last site clears the block', async () => {
        // The bug: removing the last browser-exposed site left its `.gen` hosts line
        // behind because the opt-in floor skipped the reconcile at empty. Once we HAVE
        // reconciled a non-empty set, a later empty set must still run so the hosts
        // block + Caddyfile drain to nothing.
        const reconcile = vi.fn().mockResolvedValue({});
        let routes = [route('web.acme.gen', 8001)];
        const r = createHostBrowserReconciler({ plan: () => planOf(routes), reconcile });
        await r.runNow(); // non-empty → applied
        routes = [];
        await r.runNow(); // empty → MUST still reconcile (drain)
        expect(reconcile).toHaveBeenNthCalledWith(2, planOf([]));
    });

    it('a never-opted-in machine with initiallyApplied stays FALSE untouched on empty', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        const r = createHostBrowserReconciler({ plan: () => planOf([]), reconcile });
        await r.runNow();
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('initiallyApplied:true drains a leftover block at boot (a CA on disk ⇒ opted-in before)', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        const r = createHostBrowserReconciler({ plan: () => planOf([]), reconcile, initiallyApplied: true });
        await r.runNow();
        expect(reconcile).toHaveBeenCalledWith(planOf([]));
    });

    it('debounces a burst of schedule() calls into a single reconcile (trailing edge)', () => {
        vi.useFakeTimers();
        const reconcile = vi.fn().mockResolvedValue({});
        const r = createHostBrowserReconciler({ plan: () => planOf([route('a.gen', 1)]), reconcile, debounceMs: 400 });
        r.schedule();
        r.schedule();
        r.schedule();
        expect(reconcile).not.toHaveBeenCalled(); // still within the window
        vi.advanceTimersByTime(400);
        expect(reconcile).toHaveBeenCalledTimes(1);
    });
});

// --- one elevation, not one per site (genie#225) -----------------------------
//
// On upgrade, Genie restores every enabled site. Each start fires `onChanged`,
// which calls `schedule()`. The debounce coalesces the START of a run — but a run
// that is ALREADY IN FLIGHT is holding an elevated hosts write, and on Windows
// that means a UAC prompt sitting on screen waiting for a human. Every schedule
// that landed during that wait started ANOTHER run, and another prompt.
//
// The owner's taskbar had roughly fifteen stacked UAC shields, one per hosted
// site, on a single upgrade.
//
// The hosts write itself was never the problem: `reconcileHostSites` already
// takes every route and performs ONE edit. What was missing is that a reconcile
// requested while one is running must COALESCE into a single trailing run rather
// than start a second one.

describe('reconciling while a reconcile is already running', () => {
    /** A reconcile that blocks until released — a UAC prompt awaiting a human. */
    function blockingReconcile() {
        const calls: number[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        return {
            calls,
            release: () => release(),
            fn: async (p: HostReconcilePlan) => {
                calls.push(p.routes.length);
                await gate;
                return { hostsChanged: true, caddyChanged: true } as never;
            },
        };
    }

    const route = (name: string): HostSiteRoute =>
        ({ genName: `${name}.gen`, port: 4000 }) as HostSiteRoute;

    it('does not start a second reconcile — that is the second UAC prompt', async () => {
        const blocking = blockingReconcile();
        const reconciler = createHostBrowserReconciler({
            plan: () => planOf([route('a')]),
            reconcile: blocking.fn,
            debounceMs: 0,
        });

        const first = reconciler.runNow();
        await Promise.resolve();
        // Fourteen more sites finish restoring while the prompt is up.
        for (let i = 0; i < 14; i++) reconciler.schedule();
        await new Promise((r) => setTimeout(r, 5));

        expect(blocking.calls).toHaveLength(1);

        blocking.release();
        await first;
    });

    it('still runs ONCE more afterwards, so the last change is not lost', async () => {
        // Coalescing must not mean dropping: sites that came up during the run are
        // not in the hosts file the run wrote, so exactly one follow-up is owed.
        const blocking = blockingReconcile();
        let routes: HostSiteRoute[] = [route('a')];
        const reconciler = createHostBrowserReconciler({
            plan: () => planOf(routes),
            reconcile: blocking.fn,
            debounceMs: 0,
        });

        const first = reconciler.runNow();
        await Promise.resolve();
        routes = [route('a'), route('b'), route('c')];
        for (let i = 0; i < 5; i++) reconciler.schedule();

        blocking.release();
        await first;
        await new Promise((r) => setTimeout(r, 5));

        // Exactly two: the original, and ONE trailing run carrying every route
        // that appeared while it was blocked.
        expect(blocking.calls).toEqual([1, 3]);
    });

    it('does not schedule a trailing run when nothing was requested during it', async () => {
        const blocking = blockingReconcile();
        const reconciler = createHostBrowserReconciler({
            plan: () => planOf([route('a')]),
            reconcile: blocking.fn,
            debounceMs: 0,
        });

        const first = reconciler.runNow();
        blocking.release();
        await first;
        await new Promise((r) => setTimeout(r, 5));

        expect(blocking.calls).toHaveLength(1);
    });
});

describe('suspending reconciles while every site is restored', () => {
    const route = (name: string): HostSiteRoute =>
        ({ genName: `${name}.gen`, port: 4000 }) as HostSiteRoute;

    it('prompts ONCE for a boot that restores many sites, not once per site', async () => {
        // Single-flight alone takes an upgrade from ~15 prompts to 2: one fires
        // mid-restore (the debounce elapses long before the last site is up) and
        // one trails it. Bracketing the restore closes that to 1 — which is what
        // "batch it if it must happen at all" means.
        const calls: number[] = [];
        let routes: HostSiteRoute[] = [];
        const reconciler = createHostBrowserReconciler({
            plan: () => planOf(routes),
            reconcile: async (p) => {
                calls.push(p.routes.length);
                return { hostsChanged: true, caddyChanged: true } as never;
            },
            debounceMs: 0,
        });

        const resume = reconciler.suspend();
        for (let i = 0; i < 15; i++) {
            routes = [...routes, route(`site-${i}`)];
            reconciler.schedule();
        }
        await new Promise((r) => setTimeout(r, 5));
        // Nothing yet — no prompt while sites are still coming up.
        expect(calls).toEqual([]);

        await resume();
        // ONE reconcile, carrying every site at once.
        expect(calls).toEqual([15]);
    });

    it('does not reconcile on resume when nothing asked for one', async () => {
        const calls: number[] = [];
        const reconciler = createHostBrowserReconciler({
            plan: () => planOf([route('a')]),
            reconcile: async (p) => {
                calls.push(p.routes.length);
                return { hostsChanged: true, caddyChanged: true } as never;
            },
            debounceMs: 0,
        });

        await reconciler.suspend()();
        expect(calls).toEqual([]);
    });
});

/**
 * The opt-in floor after the genie#624 split. "Exposed" is now answered by the
 * CONFIGURED names, not by what happens to be running: a machine whose only
 * browser-exposed site is stopped has still opted in, and its hosts entry must
 * survive the stop rather than being drained and re-added on the next start.
 */
describe('the opt-in floor reads the CONFIGURED half', () => {
    it('reconciles a configured site that is not running — the opt-in is the config', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        const r = createHostBrowserReconciler({
            plan: () => ({ names: ['web.acme.gen'], routes: [] }),
            reconcile,
        });
        await r.runNow();
        expect(reconcile).toHaveBeenCalledWith({ names: ['web.acme.gen'], routes: [] });
    });

    it('stopping the last RUNNING site does not drain — the name stays configured', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        let plan = { names: ['web.acme.gen'], routes: [route('web.acme.gen', 8001)] };
        const r = createHostBrowserReconciler({ plan: () => plan, reconcile });
        await r.runNow();
        plan = { names: ['web.acme.gen'], routes: [] };
        await r.runNow();
        // The second pass still carries the name, so the brain finds the hosts file
        // in sync and never elevates.
        expect(reconcile).toHaveBeenNthCalledWith(2, { names: ['web.acme.gen'], routes: [] });
    });

    it('un-configuring the last site DOES drain, once anything has been applied', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        let plan: { names: string[]; routes: HostSiteRoute[] } = { names: ['web.acme.gen'], routes: [] };
        const r = createHostBrowserReconciler({ plan: () => plan, reconcile });
        await r.runNow();
        plan = { names: [], routes: [] };
        await r.runNow();
        expect(reconcile).toHaveBeenNthCalledWith(2, { names: [], routes: [] });
    });

    it('a machine that never opted in stays untouched', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        const r = createHostBrowserReconciler({ plan: () => ({ names: [], routes: [] }), reconcile });
        await r.runNow();
        expect(reconcile).not.toHaveBeenCalled();
    });
});

it('never throws when READING the plan fails — it logs (rule 2 covers the whole pass)', async () => {
    // The plan is no longer a read of an in-memory map: since genie#624 its
    // `names` half asks the workspace store what is configured, and that read can
    // fail. It is taken inside the same guard as the reconcile, because a boot
    // where the store is briefly unreadable must not surface an unhandled
    // rejection from `void runNow()`.
    const log = vi.fn();
    const reconcile = vi.fn().mockResolvedValue({});
    const r = createHostBrowserReconciler({
        plan: () => {
            throw new Error('workspace store is locked');
        },
        reconcile,
        log,
    });
    await expect(r.runNow()).resolves.toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('workspace store is locked'));
});
