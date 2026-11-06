import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { TerminalsReplica, TerminalsService } from '../src/main/terminals-host.js';
import type { TerminalHost } from '../src/main/terminal-host.js';

it('a quiet terminal gets fresh producer metadata directly from the engine, without a cached-list precondition', async () => {
    const calls: unknown[][] = [], text = 'native' + String.fromCharCode(0xd800);
    const replica = new TerminalsReplica(async (method, args) => { calls.push([method, args]); return { id: 'quiet', pid: 55, shell: 'native', workspaceId: 'work', scrollback: text, epoch: 'producer', endOffset: 900_000 }; });
    const fresh = replica as unknown as { freshSnapshot(id: string): Promise<unknown> };
    expect(replica.list()).toEqual([]);
    expect(await fresh.freshSnapshot('quiet')).toEqual({ id: 'quiet', pid: 55, shell: 'native', workspaceId: 'work', scrollback: text, epoch: 'producer', endOffset: 900_000 });
    expect(calls).toEqual([['snapshot', ['quiet']]]);
});
it.each(['write', 'resize', 'close'])('native %s acknowledgement waits for the engine rather than the optimistic replica cache', async method => {
    let ack!: (value: boolean) => void;
    const calls: unknown[][] = [], replica = new TerminalsReplica(async (name, args) => { calls.push([name, args]); return new Promise<boolean>(resolve => { ack = resolve; }); });
    const port = replica as unknown as Record<string, (...args: unknown[]) => Promise<boolean>>;
    const args = method === 'write' ? ['quiet', 'x'] : method === 'resize' ? ['quiet', 81, 25] : ['quiet'];
    let done = false; const pending = port[`${method}Ready`]!(...args).then(value => { done = true; return value; });
    await Promise.resolve(); expect(done).toBe(false); expect(calls).toEqual([[method, args]]);
    ack(true); expect(await pending).toBe(true);
});
it('engine snapshot keeps native replica retention, authoritative counters and disposable owner isolation', async () => {
    const text = 'x'.repeat(300_000) + String.fromCharCode(0xd800), endOffset = 2_000_000;
    const terminal = { id: 'quiet', pid: 55, shell: 'native', workspaceId: 'work', scrollback: text };
    const backend = { onChange: () => () => {}, onData: () => () => {}, onExit: () => () => {}, list: () => [],
        attach: () => terminal, streamSnapshot: () => ({ id: 'quiet', tail: text, epoch: 'producer', endOffset }), open: () => terminal } as unknown as TerminalHost;
    const service = new TerminalsService(backend);
    await service.call('open', [{ id: 'quiet', workspaceId: 'work', disposable: true }], 'owner');
    expect(await service.call('snapshot', ['quiet'], 'other')).toBeNull();
    const joined = await service.call('snapshot', ['quiet'], 'owner') as typeof terminal & { epoch: string; endOffset: number };
    expect(joined.scrollback === text.slice(-262_144)).toBe(true); expect(joined.epoch).toBe('producer'); expect(joined.endOffset).toBe(endOffset);
});
it.each(['components/Workspace.tsx', 'components/TakeOverWindow.tsx', 'components/AgentView.tsx'])('the %s consumer acquires explicit displayed-terminal interest and retires broad listeners', async path => {
    const source = await readFile(new URL(`../src/renderer/${path}`, import.meta.url), 'utf8');
    expect(source).toContain('watchTerminal('); expect(source).not.toMatch(/terminals\.on(?:Data|Exit)\(/);
});
