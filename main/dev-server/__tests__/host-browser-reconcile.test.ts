import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostBrowserReconciler } from '../host-browser-reconcile';
import type { HostSiteRoute } from '../host-reconcile';

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

afterEach(() => vi.useRealTimers());

describe('createHostBrowserReconciler', () => {
    it('does NOTHING when no site is browser-exposed (no CA, no prompt)', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        const r = createHostBrowserReconciler({ routes: () => [], reconcile });
        await r.runNow();
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('reconciles to the current routes when at least one is exposed', async () => {
        const reconcile = vi.fn().mockResolvedValue({});
        const routes = [route('web.acme.gen', 8001)];
        const r = createHostBrowserReconciler({ routes: () => routes, reconcile });
        await r.runNow();
        expect(reconcile).toHaveBeenCalledWith(routes);
    });

    it('never throws when the (privileged) reconcile fails — it logs', async () => {
        const log = vi.fn();
        const reconcile = vi.fn().mockRejectedValue(new Error('trust store denied'));
        const r = createHostBrowserReconciler({ routes: () => [route('a.gen', 1)], reconcile, log });
        await expect(r.runNow()).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('trust store denied'));
    });

    it('debounces a burst of schedule() calls into a single reconcile (trailing edge)', () => {
        vi.useFakeTimers();
        const reconcile = vi.fn().mockResolvedValue({});
        const r = createHostBrowserReconciler({ routes: () => [route('a.gen', 1)], reconcile, debounceMs: 400 });
        r.schedule();
        r.schedule();
        r.schedule();
        expect(reconcile).not.toHaveBeenCalled(); // still within the window
        vi.advanceTimersByTime(400);
        expect(reconcile).toHaveBeenCalledTimes(1);
    });
});
