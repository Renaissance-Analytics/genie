import { contextBridge } from 'electron';

/**
 * THE APP WINDOW'S PRELOAD (GApps v2, V4, Tynn #569; spec .ai/plans/specs/gapps-v2.md). It exposes `window.genieApp` and
 * nothing else of Genie. The channel's address and this window's token arrive as process arguments and stay in here: the
 * page never sees them. The page can make the bridge's calls and follow its events, and nothing else.
 *
 * A sandboxed preload is CommonJS and cannot require a shared chunk, so the bridge is written out here;
 * test/gapps-v4-preload.test.ts holds this copy equal to the catalog's APP_BRIDGE.
 */
const CALLS: readonly string[] = ['app.me', 'app.call', 'app.storage.get', 'app.storage.set', 'app.storage.delete', 'app.storage.list'];
const EVENTS: readonly string[] = ['app.grantChanged', 'app.catalogChanged'];

const argument = (name: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';

interface Pending { resolve(value: unknown): void; reject(error: Error): void }

const socket = new WebSocket(argument('genie-app-channel'));
const token = argument('genie-app-token');
const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<(data: unknown) => void>>();
const queued: string[] = [];
let ready = false;
let failure: string | null = null;
let nextId = 1;

function fail(reason: string): void {
    failure = reason;
    for (const waiter of pending.values()) waiter.reject(new Error(reason));
    pending.clear();
    queued.length = 0;
}

socket.addEventListener('open', () => { socket.send(JSON.stringify({ hello: token })); });
socket.addEventListener('close', () => { fail('the app channel to Genie closed'); });
socket.addEventListener('message', (event: MessageEvent) => {
    let message: { ok?: boolean; reason?: string; id?: number; result?: unknown; error?: string; event?: string; data?: unknown };
    try { message = JSON.parse(String(event.data)) as typeof message; } catch { return; }
    if (typeof message.event === 'string') {
        for (const listener of listeners.get(message.event) ?? []) listener(message.data);
        return;
    }
    if (typeof message.id === 'number') {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error !== undefined) waiter?.reject(new Error(message.error));
        else waiter?.resolve(message.result);
        return;
    }
    if (message.ok === true) {
        ready = true;
        for (const line of queued.splice(0)) socket.send(line);
    } else if (message.ok === false) {
        fail(message.reason ?? 'Genie refused this window');
    }
});

contextBridge.exposeInMainWorld('genieApp', {
    request(method: string, params?: unknown): Promise<unknown> {
        if (!CALLS.includes(method)) return Promise.reject(new Error(`${method} is not part of the app bridge`));
        if (failure !== null) return Promise.reject(new Error(failure));
        return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            const line = JSON.stringify({ id, method, params });
            if (ready) socket.send(line);
            else queued.push(line);
        });
    },
    on(event: string, listener: (data: unknown) => void): () => void {
        if (!EVENTS.includes(event)) throw new Error(`${event} is not an event of the app bridge`);
        const set = listeners.get(event) ?? new Set();
        listeners.set(event, set);
        set.add(listener);
        return () => { set.delete(listener); };
    },
});
