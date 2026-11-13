import { describe, expect, it } from 'vitest';
import { localTerminalClient, watchTerminal } from '../src/renderer/local-terminal-client.js';

/*
 * KEYS TYPED IN A PANE'S FIRST SECOND, AT THE WINDOW LAYER (beta.61.1; omarchy-test smoke 37/38 and ui-lag). The host
 * keeps keys written in the same tick as the open (test/terminal-early-keys.test.ts); this is the layer above it: the
 * pane's keys go through the window's terminal client while its view of the terminal is still attaching — the watch
 * asked, no snapshot yet, nothing ready. Every key goes to the door at once, in order, exactly once; none waits on the
 * attach and none is dropped for want of it.
 */
type Call = { method: string; args: unknown[] };

function rig() {
    const calls: Call[] = [];
    let answerWatch: ((value: unknown) => void) | null = null;
    const port = {
        read: async <T>(method: string, ...args: unknown[]): Promise<T> => {
            calls.push({ method, args });
            if (method === 'terminals.localWatch') return await new Promise<T>((resolve) => { answerWatch = resolve as (value: unknown) => void; });
            return true as T;
        },
        release: async () => true,
        blobs: {} as never,
        on: () => () => {},
    };
    const { terminals } = localTerminalClient(port);
    return { calls, terminals, answer: (value: unknown) => answerWatch?.(value), watching: () => answerWatch !== null };
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const writes = (calls: Call[]) => calls.filter((c) => c.method === 'terminals.localWrite').map((c) => c.args[1]);

describe("a pane's keys while its terminal is still attaching", () => {
    it('go to the door at once, in order, exactly once, before the attach answers', async () => {
        const r = rig();
        const errors: string[] = [];
        watchTerminal(r.terminals, 'ws', 'term_1', { snapshot: () => {}, data: () => {}, exit: () => {}, error: (e) => errors.push(e.message) });
        await flush();
        expect(r.watching()).toBe(true);
        const sent = Promise.all(['e', 'cho', ' genie-1', '\r'].map((k) => r.terminals.write('term_1', k)));
        await flush();
        expect(writes(r.calls)).toEqual(['e', 'cho', ' genie-1', '\r']);
        await sent;
        // The attach answering afterwards sends nothing again.
        r.answer({ value: { id: 'term_1', pid: 7, shell: 'bash', scrollback: '❯ ' }, position: { epoch: 'e1', endOffset: 2 } });
        await flush();
        expect(writes(r.calls)).toEqual(['e', 'cho', ' genie-1', '\r']);
        expect(errors).toEqual([]);
    });

    it('CONTROL: with no watch at all the keys go the same way', async () => {
        const r = rig();
        await r.terminals.write('term_1', 'ls');
        expect(writes(r.calls)).toEqual(['ls']);
    });
});
