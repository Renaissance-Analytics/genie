import type { HostSiteRoute, HostReconcileResult } from './host-reconcile';

/**
 * The DESKTOP trigger for the external-browser host reconcile (story #238 P3).
 * The reconcile BRAIN (`reconcileHostSites`) owns the CA/hosts/Caddy ordering;
 * this owns only WHEN it runs:
 *
 *   1. **Opt-in floor** — no browser-exposed site ⇒ do nothing (no CA mint, no
 *      hosts edit, no Caddy, no admin prompt). This is what keeps a machine that
 *      never opts in completely untouched.
 *   2. **Never throw** — it runs from boot and from a change event; a failed
 *      privileged step is logged, not propagated.
 *   3. **Debounce** — `onChanged` fires on every site mutation; coalesce a burst.
 */

export interface HostBrowserReconcilerDeps {
    /** The current browser-exposed host-native routes (from the site manager). */
    routes: () => HostSiteRoute[];
    /** Build effects + reconcile the host to `routes`. Assembled by the desktop. */
    reconcile: (routes: HostSiteRoute[]) => Promise<HostReconcileResult>;
    /** Trailing-edge debounce window for {@link HostBrowserReconciler.schedule}. */
    debounceMs?: number;
    log?: (msg: string) => void;
}

export interface HostBrowserReconciler {
    /** Reconcile now. No-op when nothing is opted in. Never throws. */
    runNow(): Promise<void>;
    /** Trailing-edge debounced {@link runNow} — for the noisy `onChanged` event. */
    schedule(): void;
}

export function createHostBrowserReconciler(deps: HostBrowserReconcilerDeps): HostBrowserReconciler {
    const debounceMs = deps.debounceMs ?? 400;
    const log = deps.log ?? (() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function runNow(): Promise<void> {
        const routes = deps.routes();
        // Opt-in floor: nothing exposed ⇒ touch NOTHING.
        if (routes.length === 0) return;
        try {
            await deps.reconcile(routes);
        } catch (e) {
            log(`host-browser reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return {
        runNow,
        schedule() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                void runNow();
            }, debounceMs);
        },
    };
}
