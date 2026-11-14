import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('scripts/local-door-cdp.mjs', 'utf8');
const browserSource = source.slice(source.indexOf('function browserProbe('), source.indexOf('async function attachPage('));
const quietSource = source.slice(source.indexOf('const frameMetadata ='), source.indexOf('const forceUpdateCheck ='));
const demand = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
type Call = { connectionId: string; id: number; method: string; after: number };
type Frame = { kind: string; id?: number; channel?: string };
const own = (change: Partial<Call> = {}): Call => ({ connectionId: 'app', id: 1_000_001, method: 'agentDetail', after: 0, ...change });

function interval(frames: Array<{ frame: Frame; handle?: string }>, probeCalls: Call[] = [], methods = [{ id: 1_000_001, method: 'agentDetail' }, { id: 52, method: 'agentDetail' }]) {
    const page = { __doorCdp: {
        welcome: { connectionId: 'app' }, connections: new Map([['app-handle', 'app'], ['other-handle', 'other']]),
        probeCalls, frames: frames.map((item, i) => ({ seq: i + 1, action: 'frame', handle: item.handle ?? 'app-handle', frame: item.frame })),
    } };
    const main = { evaluate: async (expression: string) => new Function('window', `return (${expression});`)(page) };
    const nativeSummary = async () => ({ records: [{ connectionId: 'app', results: methods }, { connectionId: 'other', results: methods }] });
    return new Function('main', 'nativeSummary', 'demand', `${quietSource}; return quietFrames;`)(main, nativeSummary, demand) as
        (label: string, from: number, to: number, nativeDelta: number) => Promise<{ excluded: number; probeCalls: number }>;
}

describe('the local-door quiet check excludes only its own exact verification replies (Tynn #564)', () => {
    it('registers a probe agentDetail ID and connection before sending, without adopting ordinary app calls', async () => {
        let onFrame: (action: string, handle: string, text: string) => void = () => {};
        const registeredAtSend: Call[][] = [];
        const sent = vi.fn((_action: string, handle: string, text: string) => {
            const frame = JSON.parse(text) as { kind: string; id: number; method: string };
            registeredAtSend.push([...(page.__doorCdp?.probeCalls ?? [])]);
            if (frame.kind === 'call') onFrame('frame', handle, JSON.stringify({ kind: 'result', id: frame.id, ok: true, value: { rows: [] } }));
        });
        const page: { genieLocalProtocol: object; __doorCdp?: { call(method: string, args: unknown[]): Promise<unknown>; probeCalls: Call[] } } = {
            genieLocalProtocol: { onFrame: (fn: typeof onFrame) => { onFrame = fn; }, send: sent },
        };
        new Function('window', 'setInterval', 'clearInterval', 'setTimeout', `${browserSource}; browserProbe();`)(page, () => 0, () => {}, () => 0);
        onFrame('frame', 'app-handle', JSON.stringify({ kind: 'welcome', connectionId: 'app' }));
        await page.__doorCdp!.call('agentDetail', ['fixture-agent']);
        // A reply to the app's normal bridge read is observable but must never become probe-owned.
        onFrame('frame', 'app-handle', JSON.stringify({ kind: 'result', id: 52, ok: true, value: { rows: [] } }));
        expect(page.__doorCdp!.probeCalls).toEqual([own({ after: 1 })]);
        expect(registeredAtSend).toEqual([[own({ after: 1 })]]);
        expect(sent).toHaveBeenCalledWith('frame', 'app-handle', JSON.stringify({ kind: 'call', id: 1_000_001, method: 'agentDetail', args: ['fixture-agent'] }));
    });

    it('excludes exactly one matched result for each probe read in the interval', async () => {
        const quiet = interval([{ frame: { kind: 'result', id: 1_000_001 } }], [own()]);
        await expect(quiet('unwatched', 0, 1, 1)).resolves.toMatchObject({ excluded: 1, probeCalls: 1 });
    });

    it('fails when the observed exclusion count differs from the number of issued probe reads', async () => {
        const quiet = interval([{ frame: { kind: 'event', channel: 'local-headroom' } }], [own()]);
        await expect(quiet('unwatched', 0, 1, 1)).rejects.toThrow(/probe.*(count|repl|result)/i);
    });

    it('CONTROL: an app-originated agentDetail result still fails beside a legitimate probe reply', async () => {
        const quiet = interval([{ frame: { kind: 'result', id: 1_000_001 } }, { frame: { kind: 'result', id: 52 } }], [own()]);
        await expect(quiet('app read positive control', 0, 2, 2)).rejects.toThrow(/unexpected .*"id":52.*"method":"agentDetail"/);
    });

    it('CONTROL: the same ID on another connection is never excluded', async () => {
        const quiet = interval([{ frame: { kind: 'result', id: 1_000_001 }, handle: 'other-handle' }], [own()]);
        await expect(quiet('other connection', 0, 1, 1)).rejects.toThrow(/unexpected/);
    });

    it('CONTROL: a probe call issued outside the interval is never excluded', async () => {
        const quiet = interval([{ frame: { kind: 'result', id: 1_000_001 } }], [own({ after: -1 })]);
        await expect(quiet('late result', 0, 1, 1)).rejects.toThrow(/unexpected/);
    });

    it('CONTROL: a known ID with another actual method is never excluded', async () => {
        const quiet = interval([{ frame: { kind: 'result', id: 1_000_001 } }], [own()], [{ id: 1_000_001, method: 'snapshot' }]);
        await expect(quiet('wrong method', 0, 1, 1)).rejects.toThrow(/unexpected/);
    });

    it('CONTROL: agent/activity/snapshot/terminal kinds and unknown events still fail with matching IDs', async () => {
        for (const frame of [
            ...['agent', 'activity', 'snapshot', 'terminal'].map(kind => ({ kind, id: 1_000_001 })),
            ...['local-agent', 'local-activity', 'terminal', 'unknown'].map(channel => ({ kind: 'event', channel, id: 1_000_001 })),
        ]) await expect(interval([{ frame }], [own()])('unwatched push', 0, 1, 1)).rejects.toThrow(/unexpected/);
    });

    it('CONTROL: native/page counts must still agree', async () => {
        await expect(interval([{ frame: { kind: 'event', channel: 'local-headroom' } }])('count gauge', 0, 1, 2)).rejects.toThrow(/native socket and page counts agree/);
    });
});
