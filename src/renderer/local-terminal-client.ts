import type { BlobClient } from '../core/local-blobs.js';
import type { LocalTerminalMethod } from '../core/local-terminals.js';
import { encodeTerminalNativeArguments } from '../core/local-terminals.js';
import { splitTerminalText, TerminalStreamReceiver, terminalPosition } from '../core/terminal-stream.js';
import type { GenieBridge } from './bridge.js';
import { unlimited, type HeldLimit } from './local-content-client.js';

/**
 * The calls whose answer can be a held response (a snapshot, a list, an open): they share the connection's held limit with
 * Files (Tynn #547). Keystrokes, resizes and acks never wait behind a Files read.
 */
const HELD_TERMINAL_METHODS: ReadonlySet<LocalTerminalMethod> = new Set<LocalTerminalMethod>(['terminals.localWatch', 'terminals.localAttach', 'terminals.localList', 'terminals.localOpen', 'terminals.localFinish']);

type Terminals = GenieBridge['terminals'];
type Joined = NonNullable<Awaited<ReturnType<Terminals['attach']>>>;
export interface TerminalObserver {
    snapshot(value: Joined): void | Promise<void>;
    data(text: string): void | Promise<void>;
    exit(code: number): void | Promise<void>;
    error(error: Error): void;
}
type Watch = (workspaceId: string | null, id: string, observer: TerminalObserver) => () => void;
const views = new WeakMap<Terminals, Watch>();
let nextView = 0;
export function bindTerminalViews(terminals: Terminals, watch: Watch): void { views.set(terminals, watch); }

/** Interest is a displayed id. Local families bind the acknowledged protocol; existing remote routes keep their grants. */
export function watchTerminal(terminals: Terminals, workspaceId: string | null, id: string, observer: TerminalObserver): () => void {
    const local = views.get(terminals); if (local) return local(workspaceId, id, observer);
    let alive = true;
    const report = (error: unknown) => { if (alive) observer.error(error instanceof Error ? error : new Error(String(error))); };
    const offData = terminals.onData((terminalId, text) => { if (alive && terminalId === id) void Promise.resolve().then(() => { if (alive) return observer.data(text); }).catch(report); });
    const offExit = terminals.onExit((terminalId, code) => { if (alive && terminalId === id) void Promise.resolve().then(() => { if (alive) return observer.exit(code); }).catch(report); });
    void terminals.attach(workspaceId, id).then(async value => { if (alive && value) await observer.snapshot(value); }).catch(report);
    return () => { alive = false; offData(); offExit(); };
}

export function terminalAction(action: () => void | Promise<void>, report: (error: string) => void): void {
    void Promise.resolve().then(action).catch(error => report(error instanceof Error ? error.message : String(error)));
}

interface Port {
    read<T>(method: LocalTerminalMethod, ...args: unknown[]): Promise<T>;
    release(ref: string): Promise<unknown>;
    blobs: BlobClient;
    on(channel: string, listener: (payload: unknown) => void): () => void;
    limit?: HeldLimit;
}
interface ViewState { view: string; id: string; alive: boolean; receiver: TerminalStreamReceiver; chain: Promise<void>; observer: TerminalObserver; restart(): Promise<void> }

export function localTerminalClient(port: Port): { terminals: Terminals; dispose(): void } {
    const active = new Map<string, ViewState>(), dataListeners = new Set<(id: string, data: string) => void>(), exitListeners = new Set<(id: string, code: number) => void>();
    let closed = false;
    const request = async <T>(method: LocalTerminalMethod, ...args: unknown[]): Promise<T> => {
        if (closed) throw new Error('terminal connection is closed');
        return (HELD_TERMINAL_METHODS.has(method) ? port.limit ?? unlimited : unlimited)(async () => {
            const result = await port.read<T | { terminalContent: { ref: string; blob: string } }>(method, ...args);
            if (!result || typeof result !== 'object' || !('terminalContent' in result)) return result as T;
            const content = result.terminalContent;
            try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await port.blobs.readAll('terminal-json', content.blob))) as T; }
            finally { await port.release(content.ref); }
        });
    };
    const stop = (state: ViewState) => {
        if (!state.alive) return; state.alive = false; active.delete(state.view);
        if (!closed) void request('terminals.localUnwatch', state.view).catch(() => {});
    };
    const fail = (state: ViewState, error: unknown) => {
        if (!state.alive) return; stop(state); state.observer.error(error instanceof Error ? error : new Error(String(error)));
    };
    const onEvent = (payload: unknown) => {
        const packet = payload as { view?: unknown; sequence?: unknown; event?: { kind: string; id: string; data?: string; offset?: number; epoch?: string; endOffset?: number; exitCode?: number } } | null;
        const state = typeof packet?.view === 'string' ? active.get(packet.view) : undefined;
        if (!state || !packet?.event) return;
        const event = packet.event;
        state.chain = state.chain.then(async () => {
            if (!state.alive) return;
            if (event.id !== state.id || !Number.isSafeInteger(packet.sequence)) throw new Error('terminal connection closed: invalid output frame');
            if (event.kind === 'resync') { await state.restart(); return; }
            const result = event.kind === 'data' ? state.receiver.data(event as { id: string; data: string; epoch: string; offset: number })
                : event.kind === 'exit' ? state.receiver.exit(event as { id: string; epoch: string; endOffset: number; exitCode: number }) : { kind: 'resync' as const };
            if (result.kind === 'resync') { await state.restart(); return; }
            if (result.kind === 'data') {
                await state.observer.data(result.data);
                if (state.alive) for (const listener of dataListeners) listener(state.id, result.data);
            } else if (result.kind === 'exit') {
                await state.observer.exit(event.exitCode!);
                if (state.alive) for (const listener of exitListeners) listener(state.id, event.exitCode!);
            }
            if (state.alive) await request('terminals.localAck', state.view, packet.sequence);
        }).catch(error => fail(state, error));
    };
    const offData = port.on('terminal-data', onEvent), offExit = port.on('terminal-exit', onEvent);
    const watch: Watch = (workspaceId, id, observer) => {
        let current: ViewState | null = null, alive = true;
        const start = async (): Promise<void> => {
            if (!alive || closed) return;
            if (current) stop(current);
            const state: ViewState = { view: `terminal-view-${++nextView}`, id, alive: true, receiver: new TerminalStreamReceiver(), chain: Promise.resolve(), observer, restart: start };
            current = state; active.set(state.view, state);
            try {
                const snapshot = await request<{ value: Joined; position: unknown } | null>('terminals.localWatch', state.view, ...encodeTerminalNativeArguments('attach', [workspaceId, id]));
                if (!state.alive) return;
                if (!snapshot) throw new Error(`terminal ${id} is gone or closed`);
                const position = terminalPosition(snapshot.position), value = snapshot.value;
                if (!position) throw new Error('terminal producer position is unavailable; a fresh full snapshot is required');
                if (value?.id !== id || typeof value.scrollback !== 'string') throw new Error('terminal connection closed: invalid snapshot');
                const attached = state.receiver.attach({ id, tail: value.scrollback, ...position });
                if (attached.kind === 'resync') throw new Error('terminal snapshot has an invalid producer position');
                await observer.snapshot(value);
                if (state.alive) await request('terminals.localReady', state.view);
            } catch (error) { fail(state, error); }
        };
        void start();
        return () => { alive = false; if (current) stop(current); };
    };
    const transfer = async <T>(requestValue: unknown, text: string): Promise<T> => {
        const ticket = await request<string>('terminals.localBegin', requestValue);
        try {
            for (const chunk of splitTerminalText(text)) await request('terminals.localChunk', ticket, chunk.data);
            return await request<T>('terminals.localFinish', ticket);
        } catch (error) {
            // Abort a partial command rather than opening it. Input already acknowledged by native is drained.
            try { await request('terminals.localFinish', ticket, true); } catch { /* disconnect owns cleanup */ }
            throw error;
        }
    };
    const accepted = async (call: Promise<boolean>): Promise<void> => { if (!await call) throw new Error('terminal is gone or closed'); };
    const terminals: Terminals = {
        open: async (workspaceId, options) => {
            const args = encodeTerminalNativeArguments('open', [workspaceId, options]), nativeOptions = args[1] as Record<string, unknown>;
            if (typeof nativeOptions['command'] === 'string') {
                const chunks = splitTerminalText(nativeOptions['command']); chunks.next();
                if (!chunks.next().done) { const { command, ...rest } = nativeOptions; return transfer({ kind: 'open', workspaceId: args[0], options: rest }, command as string); }
            }
            return request('terminals.localOpen', ...args);
        },
        write: async (id, data) => {
            const args = encodeTerminalNativeArguments('write', [id, data]);
            if (typeof args[0] === 'string' && typeof args[1] === 'string') {
                const chunks = splitTerminalText(args[1]); chunks.next();
                if (!chunks.next().done) return accepted(transfer({ kind: 'write', id: args[0] }, args[1]));
            }
            return accepted(request('terminals.localWrite', ...args));
        },
        resize: (id, cols, rows) => accepted(request('terminals.localResize', ...encodeTerminalNativeArguments('resize', [id, cols, rows]))),
        close: id => accepted(request('terminals.localClose', ...encodeTerminalNativeArguments('close', [id]))),
        list: workspaceId => request('terminals.localList', ...encodeTerminalNativeArguments('list', [workspaceId])),
        attach: (workspaceId, id) => request('terminals.localAttach', ...encodeTerminalNativeArguments('attach', [workspaceId, id])),
        onData: listener => { dataListeners.add(listener); return () => { dataListeners.delete(listener); }; },
        onExit: listener => { exitListeners.add(listener); return () => { exitListeners.delete(listener); }; },
    };
    bindTerminalViews(terminals, watch);
    return { terminals, dispose: () => {
        closed = true; offData(); offExit();
        for (const state of active.values()) fail(state, new Error('terminal connection disconnected'));
        active.clear(); dataListeners.clear(); exitListeners.clear();
    } };
}
