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
    /**
     * Seed the "have we ever applied?" latch from durable state (a Genie CA on
     * disk ⇒ this machine opted in before), so a boot with zero live sites still
     * DRAINS a leftover `.gen` hosts line from a previous session.
     */
    initiallyApplied?: boolean;
    log?: (msg: string) => void;
}

export interface HostBrowserReconciler {
    /** Reconcile now. No-op when nothing is opted in. Never throws. */
    runNow(): Promise<void>;
    /** Trailing-edge debounced {@link runNow} — for the noisy `onChanged` event. */
    schedule(): void;
    /**
     * Hold reconciles until the returned `resume()` is awaited, then run ONCE if
     * anything asked while suspended.
     *
     * For boot restore: Genie brings every enabled site back one at a time and
     * each start fires `onChanged`. Without this, the debounce elapses long
     * before the last site is up, so a reconcile — and its UAC prompt — fires
     * mid-restore and another trails it. Bracketing the restore makes an upgrade
     * cost ONE prompt carrying every site, instead of one per site.
     */
    suspend(): () => Promise<void>;
}

export function createHostBrowserReconciler(deps: HostBrowserReconcilerDeps): HostBrowserReconciler {
    const debounceMs = deps.debounceMs ?? 400;
    const log = deps.log ?? (() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Have we ever reconciled a non-empty set (or opted in a prior session)? Until
    // then, an empty set means "never touched this machine" and we stay silent. Once
    // true, an empty set is a real DRAIN (clear the hosts block + Caddyfile).
    let applied = deps.initiallyApplied ?? false;

    /** One pass: read the current routes and reconcile the host to them. */
    async function execute(): Promise<void> {
        const routes = deps.routes();
        // Opt-in floor, but NOT a teardown floor: skip only when nothing is exposed
        // AND we have never applied — otherwise removing the last site must drain.
        if (routes.length === 0 && !applied) return;
        try {
            await deps.reconcile(routes);
            if (routes.length > 0) applied = true;
        } catch (e) {
            log(`host-browser reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * SINGLE-FLIGHT (genie#225). A reconcile requested while one is running
     * coalesces into a single trailing pass instead of starting a second one.
     *
     * The debounce above only coalesces the START of a run. A run in flight is
     * holding an elevated hosts write, and on Windows that is a UAC prompt
     * sitting on screen until a human answers it — seconds, or minutes. Every
     * request that arrived during that wait used to start its own run and its own
     * prompt. On upgrade, where Genie restores every enabled site and each start
     * fires `onChanged`, that stacked roughly one UAC shield PER HOSTED SITE.
     *
     * The trailing pass is not optional: sites that came up while the first run
     * was blocked are not in the hosts file it wrote, so exactly one follow-up is
     * owed — coalescing must not mean dropping. It loops rather than running once
     * so that a request arriving during the TRAILING pass is honoured too, which
     * is the same race one level down.
     */
    let running: Promise<void> | null = null;
    let rerunRequested = false;

    let suspended = 0;
    let requestedWhileSuspended = false;

    async function runNow(): Promise<void> {
        if (suspended > 0) {
            requestedWhileSuspended = true;
            return;
        }
        if (running) {
            rerunRequested = true;
            return running;
        }
        running = (async () => {
            try {
                await execute();
                while (rerunRequested) {
                    rerunRequested = false;
                    await execute();
                }
            } finally {
                running = null;
            }
        })();
        return running;
    }

    return {
        runNow,
        suspend() {
            suspended++;
            let resumed = false;
            return async () => {
                // Idempotent: a caller that resumes twice (a retry, a finally
                // that also runs on the happy path) must not unbalance the count
                // and let a later suspend leak.
                if (resumed) return;
                resumed = true;
                suspended--;
                if (suspended > 0) return;
                if (!requestedWhileSuspended) return;
                requestedWhileSuspended = false;
                await runNow();
            };
        },
        schedule() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                void runNow();
            }, debounceMs);
        },
    };
}
