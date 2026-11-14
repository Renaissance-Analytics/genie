import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// Execute the probe's actual observer functions with only CDP/socket ports replaced.
// Importing its entry point would launch Electron, which this unit test must never do.
const source = readFileSync('scripts/local-door-cdp.mjs', 'utf8');
const observerSource = source.slice(source.indexOf('async function observeDoor('), source.indexOf('const nativeSummary ='));
const metadataSource = source.slice(source.indexOf('const frameMetadata ='), source.indexOf('const forceUpdateCheck ='));
const demand = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
type Metadata = { id: number | null; method: string | null };
type RecordSummary = { connectionId: string; frames: number; closed: boolean; results: Metadata[] };

async function nativeObserver() {
    const listeners = new Set<(socket: unknown) => void>();
    const scope: { __doorNative?: { summary(): { records: RecordSummary[] } } } = {};
    const inspector = {
        send: vi.fn(async (_method: string, params: { functionDeclaration: string }) => {
            const install = new Function('globalThis', `return (${params.functionDeclaration});`)(scope);
            return { result: { value: install.call(listeners, new Map(), () => {}) } };
        }),
    };
    await new Function('inspector', 'demand', `${observerSource}; return observeDoor({});`)(inspector, demand);
    const connect = (connectionId: string) => {
        let receive: (text: string) => void = () => {}, close: () => void = () => {};
        const socket = {
            send: vi.fn((_text: string) => {}),
            onMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
            onClose: (fn: typeof close) => { close = fn; return () => {}; },
        };
        for (const listener of listeners) listener(socket);
        socket.send(JSON.stringify({ kind: 'welcome', connectionId, isOwner: true }));
        return {
            call: (id: number, method: string) => receive(JSON.stringify({ kind: 'call', id, method, args: ['private fixture argument'] })),
            reply: (id: number) => socket.send(JSON.stringify({ kind: 'result', id, ok: true, value: 'private fixture result' })),
            close: () => close(),
        };
    };
    return { connect, summary: () => scope.__doorNative!.summary() };
}

describe('local-door failure evidence identifies a reply by its actual request (Tynn #564)', () => {
    it('records result IDs and methods without logging arguments or result values', async () => {
        const observer = await nativeObserver(), socket = observer.connect('app');
        socket.call(101, 'agentDetail'); socket.reply(101);
        socket.call(102, 'snapshot'); socket.reply(102);
        expect(observer.summary().records[0]?.results).toEqual([
            { id: 101, method: 'agentDetail' }, { id: 102, method: 'snapshot' },
        ]);
        expect(JSON.stringify(observer.summary())).not.toContain('private fixture');
    });

    it('does not attribute another connection or an unsolicited result to a known request', async () => {
        const observer = await nativeObserver(), app = observer.connect('app'), child = observer.connect('child');
        app.call(101, 'agentDetail'); child.call(101, 'workspaces.settings');
        child.reply(101); app.reply(101); app.reply(999);
        expect(observer.summary().records.map(record => record.results)).toEqual([
            [{ id: 101, method: 'agentDetail' }, { id: 999, method: null }],
            [{ id: 101, method: 'workspaces.settings' }],
        ]);
    });

    it('includes the request ID and method in the page frame failure metadata', async () => {
        const records = [
            { seq: 1, action: 'frame', frame: { kind: 'result', id: 101 } },
            { seq: 2, action: 'frame', frame: { kind: 'event', channel: 'local-snapshot' } },
        ];
        const page = { __doorCdp: { frames: records, welcome: { connectionId: 'app' } } };
        const main = { evaluate: (expression: string) => new Function('window', `return (${expression});`)(page) };
        const summary = { records: [{ connectionId: 'app', results: [{ id: 101, method: 'agentDetail' }] }] };
        const metadata = new Function('main', 'nativeSummary', 'demand', `${metadataSource}; return frameMetadata;`)(main, async () => summary, demand);
        expect(await metadata(0, 2)).toEqual([
            { seq: 1, action: 'frame', kind: 'result', channel: null, id: 101, method: 'agentDetail' },
            { seq: 2, action: 'frame', kind: 'event', channel: 'local-snapshot', id: null, method: null },
        ]);
    });

    it('CONTROL: the observer still counts every native frame and records socket release', async () => {
        const observer = await nativeObserver(), socket = observer.connect('app');
        socket.call(101, 'agentDetail'); socket.reply(101); socket.close();
        expect(observer.summary().records[0]).toMatchObject({ connectionId: 'app', frames: 2, closed: true });
    });

    it('CONTROL: result frames and unknown channels remain failures during a quiet interval', async () => {
        for (const frame of [{ kind: 'result', id: 101 }, { kind: 'event', channel: 'local-agent' }, { kind: 'event', channel: 'unknown' }]) {
            const page = { __doorCdp: { frames: [{ seq: 1, action: 'frame', frame }], welcome: { connectionId: 'app' } } };
            const main = { evaluate: (expression: string) => new Function('window', `return (${expression});`)(page) };
            const quiet = new Function('main', 'nativeSummary', 'demand', `${metadataSource}; return quietFrames;`)(main, async () => ({ records: [] }), demand);
            await expect(quiet('unwatched', 0, 1, 1)).rejects.toThrow(/zero agent\/activity\/snapshot\/terminal or unknown frames/);
        }
    });
});
