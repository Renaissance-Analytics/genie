/**
 * A FREEZE LEAVES A TRACE (beta.53; the owner, 2026-10-31: "periodic whole UI freezes where my typing stops", then
 * "everything in genie was frozen for 2 or 3 minutes" — and `lifecycle.log` had nothing after the boot, so nothing could
 * say whether main was held, a renderer was, or something was only WAITING). This writes each of those to the lifecycle
 * log as it happens:
 *
 *  - `stall main ms=… route=… during=…` — main's event loop held over {@link MAIN_STALL_MS}: a heartbeat came late. With
 *    the route on screen and the renderer requests main was in the middle of answering (the cheap "what was running");
 *  - `ipc waiting channel=… ms=…` once a renderer request (`ipcRenderer.invoke`) has waited {@link IPC_SLOW_MS}, then
 *    `ipc slow channel=… ms=…` when it is answered. Logged WHILE it waits, so a request that never ends still shows: a
 *    window waiting on main while main itself is idle is a freeze no CPU reading finds;
 *  - `net waiting host=…` / `net slow host=…` — an outbound HTTP call over {@link NET_SLOW_MS}, the same two ways;
 *  - `stall renderer kind=longtask|frames ms=… window=… route=…` — what a window reports about itself (preload
 *    `watchRendererStalls`): a long task, or no frame presented, over {@link RENDERER_STALL_MS};
 *  - `renderer unresponsive|responsive` (Electron's own hang signal) and `process gone` (the GPU process among them).
 *
 * Pure, with its clock and heartbeat injected: main wires it (main.ts), the tests drive it. Every line is one line — a
 * renderer's text is cut short and has its line breaks removed, so a window cannot write lines of its own into the log.
 *
 * This is the HOST's concern and moves with it: when the host runs as its own service (the host/client split), the
 * heartbeat and the request timing go there, and each window keeps only its own long-task and frame report.
 */

export const MAIN_STALL_MS = 1_000;
export const IPC_SLOW_MS = 1_000;
export const NET_SLOW_MS = 5_000;
export const RENDERER_STALL_MS = 1_000;
export const HEARTBEAT_MS = 200;
const TEXT_MAX = 160;

export interface StallWatchdogOptions {
    readonly log: (line: string) => void;
    readonly now?: () => number;
    /** Run `fn` every {@link HEARTBEAT_MS}; returns how to stop. Default: an unref'd setInterval. */
    readonly every?: (fn: () => void, ms: number) => () => void;
    /** The route on screen in the main window, or null. */
    readonly routeOf?: () => string | null;
    /** Told after each main block is logged, with its length: main's stack sample is read then (stall-profile.ts). */
    readonly onMainStall?: (ms: number) => void;
}

interface Pending { readonly what: string; readonly at: number; told: boolean }

/** One line of text from elsewhere: no line breaks, no control characters, at most {@link TEXT_MAX} characters. */
function clean(value: unknown): string {
    const s = typeof value === 'string' ? value : '';
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, TEXT_MAX);
}

export class StallWatchdog {
    readonly #log: (line: string) => void;
    readonly #now: () => number;
    readonly #every: (fn: () => void, ms: number) => () => void;
    readonly #routeOf: () => string | null;
    readonly #onMainStall: (ms: number) => void;
    readonly #ipc = new Set<Pending>();
    readonly #net = new Set<Pending>();
    readonly #hung = new Map<string, number>();
    #last = 0;
    #stop: (() => void) | null = null;

    constructor(options: StallWatchdogOptions) {
        this.#log = options.log;
        this.#now = options.now ?? Date.now;
        this.#every = options.every ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); });
        this.#routeOf = options.routeOf ?? (() => null);
        this.#onMainStall = options.onMainStall ?? (() => {});
    }

    start(): void {
        if (this.#stop) return;
        this.#last = this.#now();
        this.#stop = this.#every(() => this.#beat(), HEARTBEAT_MS);
    }

    stop(): void {
        this.#stop?.();
        this.#stop = null;
    }

    /** A renderer request began on `channel`; call the result when it is answered (or throws). */
    ipc(channel: string): () => void {
        return this.#track(this.#ipc, clean(channel), IPC_SLOW_MS, 'ipc slow channel');
    }

    /** An outbound call to `host` began; call the result when it ends. */
    net(host: string): () => void {
        return this.#track(this.#net, clean(host), NET_SLOW_MS, 'net slow host');
    }

    /** A window's own report (preload `watchRendererStalls`), validated here: it comes from a renderer. */
    renderer(report: unknown, window: string): void {
        if (typeof report !== 'object' || report === null) return;
        const { kind, ms, route } = report as Record<string, unknown>;
        if (kind !== 'longtask' && kind !== 'frames') return;
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < RENDERER_STALL_MS) return;
        this.#log(`stall renderer kind=${kind} ms=${Math.round(Math.min(ms, 86_400_000))} window=${clean(window)} route=${clean(route)}`);
    }

    /** Electron's `unresponsive` (true) and `responsive` (false) for a window. */
    unresponsive(window: string, hung: boolean): void {
        const name = clean(window);
        if (hung) {
            if (!this.#hung.has(name)) this.#hung.set(name, this.#now());
            this.#log(`renderer unresponsive window=${name}`);
            return;
        }
        const since = this.#hung.get(name);
        this.#hung.delete(name);
        this.#log(`renderer responsive window=${name}${since === undefined ? '' : ` after_ms=${this.#now() - since}`}`);
    }

    /** `app` 'child-process-gone' (a GPU, utility or plugin process) and 'render-process-gone'. */
    processGone(details: { type?: unknown; reason?: unknown; exitCode?: unknown }): void {
        this.#log(`process gone type=${clean(details.type)} reason=${clean(details.reason)} exit=${typeof details.exitCode === 'number' ? details.exitCode : '?'}`);
    }

    #track(set: Set<Pending>, what: string, slowMs: number, slowLine: string): () => void {
        const p: Pending = { what, at: this.#now(), told: false };
        set.add(p);
        let done = false;
        return () => {
            if (done) return;
            done = true;
            set.delete(p);
            const ms = this.#now() - p.at;
            if (ms >= slowMs) this.#log(`${slowLine}=${what} ms=${ms}`);
        };
    }

    #beat(): void {
        const now = this.#now();
        const gap = now - this.#last - HEARTBEAT_MS;
        this.#last = now;
        if (gap >= MAIN_STALL_MS) {
            const during = [...new Set([...this.#ipc].map((p) => p.what))].slice(0, 6).join(',');
            this.#log(`stall main ms=${gap} route=${clean(this.#routeOf())}${during ? ` during=${during}` : ''}`);
            try { this.#onMainStall(gap); } catch { /* a stack is a bonus */ }
        }
        for (const p of this.#ipc) if (!p.told && now - p.at >= IPC_SLOW_MS) { p.told = true; this.#log(`ipc waiting channel=${p.what} ms=${now - p.at}`); }
        for (const p of this.#net) if (!p.told && now - p.at >= NET_SLOW_MS) { p.told = true; this.#log(`net waiting host=${p.what} ms=${now - p.at}`); }
    }
}

/**
 * EVERY `ipcMain.handle` TIMED: the handler `ipcMain.handle` is given is wrapped so the watchdog sees each request from
 * start to answer. Installed before any handler is registered; `invoke` already answers with a promise, so wrapping a
 * synchronous handler in an async one changes nothing a renderer sees (a throw still rejects its invoke).
 */
export function timeIpcHandlers(ipc: { handle: (channel: string, listener: (...args: never[]) => unknown) => void }, dog: Pick<StallWatchdog, 'ipc'>): void {
    const original = ipc.handle.bind(ipc);
    ipc.handle = (channel, listener) => original(channel, async (...args: never[]) => {
        const done = dog.ipc(channel);
        try {
            return await (listener as (...a: never[]) => unknown)(...args);
        } finally {
            done();
        }
    });
}

/**
 * EVERY OUTBOUND HTTP CALL TIMED, by host, through Node's diagnostics channels: `fetch` (undici) and `http`/`https`
 * requests. A WebSocket upgrade is a request that answers with a 101 and ends there; the socket after it is not a call.
 */
export function watchOutboundCalls(dc: { subscribe(name: string, fn: (message: unknown) => void): void }, dog: Pick<StallWatchdog, 'net'>): void {
    const open = new WeakMap<object, () => void>();
    const begin = (key: unknown, host: unknown) => { if (typeof key === 'object' && key !== null && !open.has(key)) open.set(key, dog.net(typeof host === 'string' ? host : '?')); };
    const end = (key: unknown) => { if (typeof key !== 'object' || key === null) return; open.get(key)?.(); open.delete(key); };
    const hostOf = (origin: unknown): string => { try { return new URL(String(origin)).host; } catch { return String(origin); } };
    dc.subscribe('undici:request:create', (m) => { const r = (m as { request?: { origin?: unknown } }).request; begin(r, hostOf(r?.origin)); });
    dc.subscribe('undici:request:trailers', (m) => end((m as { request?: object }).request));
    dc.subscribe('undici:request:error', (m) => end((m as { request?: object }).request));
    dc.subscribe('http.client.request.start', (m) => { const r = (m as { request?: { host?: unknown; getHeader?: (n: string) => unknown } }).request; begin(r, r?.host ?? r?.getHeader?.('host')); });
    dc.subscribe('http.client.response.finish', (m) => end((m as { request?: object }).request));
    dc.subscribe('http.client.request.error', (m) => end((m as { request?: object }).request));
}
