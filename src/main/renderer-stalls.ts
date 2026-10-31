/**
 * A WINDOW'S OWN STALLS, REPORTED TO MAIN (beta.53 freezes; main/stall-watchdog.ts writes them to the lifecycle log). Run
 * from a preload, so every window that loads it reports — the main window, the flow editor, the files window:
 *
 *  - `longtask`: the page's thread busy over 1 s in one task (PerformanceObserver);
 *  - `frames`: no animation frame for over 1 s while the page is VISIBLE — a hung page, or a GPU / compositor that
 *    stopped presenting, which no CPU reading shows. A hidden or minimised window gets no frames by design: a gap that
 *    began or ended hidden is not reported.
 *
 * Each report carries the page's route (`location.hash`). Sent with `send`, never `invoke`: a report never waits on main.
 */
export interface StallReport { readonly kind: 'longtask' | 'frames'; readonly ms: number; readonly route: string }

export interface RendererStallEnv {
    readonly requestAnimationFrame: (cb: (t: number) => void) => unknown;
    readonly now: () => number;
    readonly visible: () => boolean;
    readonly route: () => string;
    /** Told when the page is shown or hidden: a gap across a hide is not a stall. */
    readonly onVisibilityChange?: ((cb: () => void) => void) | undefined;
    /** Subscribe to long tasks; absent where the page has no `longtask` entry type. */
    readonly observeLongTasks?: ((cb: (durationMs: number) => void) => void) | undefined;
}

export const STALL_REPORT_MS = 1_000;

export function watchRendererStalls(send: (report: StallReport) => void, env: RendererStallEnv): void {
    env.observeLongTasks?.((ms) => { if (ms >= STALL_REPORT_MS) send({ kind: 'longtask', ms: Math.round(ms), route: env.route() }); });
    let last: number | null = null;
    env.onVisibilityChange?.(() => { last = null; });
    const frame = (): void => {
        const now = env.now();
        if (!env.visible()) last = null;
        else {
            if (last !== null && now - last >= STALL_REPORT_MS) send({ kind: 'frames', ms: Math.round(now - last), route: env.route() });
            last = now;
        }
        env.requestAnimationFrame(frame);
    };
    env.requestAnimationFrame(frame);
}

/** The browser's own environment for {@link watchRendererStalls}, as a preload sees it; `null` outside a page (a test). */
export function browserStallEnv(): RendererStallEnv | null {
    if (typeof globalThis.requestAnimationFrame !== 'function' || typeof document === 'undefined') return null;
    return {
        requestAnimationFrame: (cb) => globalThis.requestAnimationFrame(cb),
        now: () => performance.now(),
        visible: () => document.visibilityState === 'visible',
        route: () => location.hash,
        onVisibilityChange: (cb) => document.addEventListener('visibilitychange', cb),
        observeLongTasks: typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
            ? (cb) => { new PerformanceObserver((list) => { for (const e of list.getEntries()) cb(e.duration); }).observe({ type: 'longtask' }); }
            : undefined,
    };
}
