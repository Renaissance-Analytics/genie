import type { SessionDriver, SessionDriverFactory } from '../core/session.js';
import { mcpPreparationMessage } from './mcp-preparation-error.js';

/** Preparation and the provider handshake share the session's existing readiness gate and input queue. */
export function deferredDriverFactory(prepare: (signal: AbortSignal) => Promise<SessionDriverFactory>): SessionDriverFactory {
    return (options) => {
        const controller = new AbortController();
        let inner: SessionDriver | undefined;
        let started = false;
        let exited = false;
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        void ready.catch(() => {});
        const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
            if (exited) return;
            exited = true;
            options.events.onExit?.(code, signal);
            reject(new Error('The provider ended before it was ready.'));
        };
        const abort = (): void => { controller.abort(); resolve(); };
        const driver: SessionDriver = {
            start() { driver.startTracked!((spawn) => spawn()); },
            startTracked(aroundSpawn) {
                if (started || controller.signal.aborted) return;
                started = true;
                // Before preparation there is no provider. Stop can verify that empty tree. The second snapshot
                // surrounds only the real spawn, excluding children another agent started during the network wait.
                aroundSpawn(() => {});
                void Promise.resolve().then(() => {
                    if (controller.signal.aborted) return null;
                    return prepare(controller.signal);
                }).then(async (factory) => {
                    if (controller.signal.aborted) return;
                    if (!factory) return;
                    inner = factory({ ...options, events: { ...options.events, onExit: exit } });
                    // Optional capabilities stay optional. In particular, a driver without stop still gets the
                    // session's original endInput/grace path, rather than an invented stop implementation.
                    if (inner.stop) driver.stop = inner.stop.bind(inner);
                    else delete driver.stop;
                    if (inner.endInput) driver.endInput = inner.endInput.bind(inner);
                    if (inner.cancel) driver.cancel = inner.cancel.bind(inner);
                    if (inner.modelState) driver.modelState = inner.modelState.bind(inner);
                    if (inner.setModel) driver.setModel = inner.setModel.bind(inner);
                    aroundSpawn(() => inner!.start());
                    await inner.ready;
                    if (!controller.signal.aborted && !exited) resolve();
                }).catch((error: unknown) => {
                    if (controller.signal.aborted || exited) return;
                    // Credential preparation exceptions can contain a key or an HTTP response. Only this fixed
                    // message or a fixed main-process failure code crosses into the ledger or renderer.
                    const reason = mcpPreparationMessage(error);
                    options.events.onProtocolError?.(reason, { recoverable: false });
                    try { inner?.kill(); } catch { /* the session still owns and records a partial spawn */ }
                    finally { exit(null, null); reject(new Error(reason)); }
                });
            },
            prompt(content) {
                if (!inner || controller.signal.aborted) throw new Error('The agent is still preparing its connection.');
                inner.prompt(content);
            },
            kill(signal) { abort(); inner?.kill(signal); },
            stop: async () => { abort(); },
            get running() { return !controller.signal.aborted && !exited && (inner?.running ?? true); },
            get cliSessionId() { return inner?.cliSessionId ?? null; },
            ready,
        };
        return driver;
    };
}
