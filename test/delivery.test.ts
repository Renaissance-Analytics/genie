import { describe, expect, it } from 'vitest';
import { deliveryFrom } from '../src/core/delivery.js';
import { toStreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE DASHBOARD'S "LATEST DELIVERY" — THE DESIGN MOCKUP'S COLUMN, FILLED (the owner, 2026-10-19: "make sure the dashboard
 * is actually following the design mockups"). The session host answered `lastDelivery: null` for every agent, so the
 * column was always empty. Now it is the agent's own latest delivery, read from its session's rows, newest first:
 *
 *   - a commit it made: the sha and the message, from git's OWN output (`[branch sha] message`) — never guessed;
 *   - a file it wrote: the path, and + / − from the real edit (stream-view's `editLineCounts`);
 *   - a handoff: `→ peer` and what it said (agentinbox send, imDone);
 *   - its answer: the first line of what it said at the end of its turn.
 */

const NOW = 1_800_000_000_000;
let n = 0;
const row = (event: TimedEvent['event'], agoMs: number): TimedEvent => ({ id: `r${n++}`, event, at: NOW - agoMs });
const tool = (o: { id: string; name?: string; kind?: string; status?: string; input?: unknown; output?: unknown; content?: unknown }, agoMs: number) =>
    row(toStreamEvent({ sessionUpdate: o.status ? 'tool_call_update' : 'tool_call', toolCallId: o.id, name: o.name, kind: o.kind, status: o.status, rawInput: o.input, rawOutput: o.output, content: o.content })!, agoMs);
const said = (text: string, agoMs: number) => row({ kind: 'message', speaker: 'agent', peerName: null, text }, agoMs);

describe('deliveryFrom', () => {
    it('a commit: the sha and message from git’s own output, the age', () => {
        const rows = [
            tool({ id: 'c1', name: 'Bash', kind: 'execute', input: { command: 'git commit -m "feat(auth): passkey challenge store"' } }, 200_000),
            tool({ id: 'c1', status: 'completed', output: '[main 9e1c2af] feat(auth): passkey challenge store\n 2 files changed, 40 insertions(+)' }, 180_000),
        ];
        expect(deliveryFrom(rows, NOW)).toEqual({ kind: 'commit', main: '9e1c2af', sub: 'feat(auth): passkey challenge store', plus: null, minus: null, age: '3m' });
    });

    it('git’s output in ACP `content` blocks reads the same', () => {
        const rows = [
            tool({ id: 'c2', name: 'Bash', kind: 'execute', input: { command: 'git commit -am "fix: x"' } }, 70_000),
            tool({ id: 'c2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '[feature/a b0e2d91] fix: x' } }] }, 60_000),
        ];
        expect(deliveryFrom(rows, NOW)).toMatchObject({ kind: 'commit', main: 'b0e2d91', sub: 'fix: x' });
    });

    it('a commit that FAILED, or whose output names no sha, is no delivery — never a guessed sha', () => {
        const failed = [
            tool({ id: 'c3', name: 'Bash', kind: 'execute', input: { command: 'git commit -m "x"' } }, 20_000),
            tool({ id: 'c3', status: 'failed', output: 'nothing to commit, working tree clean' }, 10_000),
        ];
        expect(deliveryFrom(failed, NOW)).toBeNull();
    });

    it('a file: its path and the real + / − of the edit', () => {
        const rows = [
            tool({ id: 'e1', name: 'Edit', kind: 'edit', input: { file_path: 'src/Providers/Gemini.php', old_string: 'a\nb', new_string: 'a\nc\nd' } }, 70_000),
            tool({ id: 'e1', status: 'completed' }, 60_000),
        ];
        expect(deliveryFrom(rows, NOW)).toEqual({ kind: 'file', main: 'src/Providers/Gemini.php', sub: null, plus: 2, minus: 1, age: '1m' });
    });

    it('a handoff: → the peer and what it said (agentinbox send; imDone)', () => {
        const send = [
            tool({ id: 'h1', name: 'mcp__genie__agentinbox', input: { action: 'send', to: 'tynn:claude:atlas', text: 'hunk ids are stable across rebases' } }, 9 * 60_000),
            tool({ id: 'h1', status: 'completed' }, 9 * 60_000),
        ];
        expect(deliveryFrom(send, NOW)).toEqual({ kind: 'handoff', main: '→ tynn:claude:atlas', sub: 'hunk ids are stable across rebases', plus: null, minus: null, age: '9m' });
        const done = [
            tool({ id: 'h2', name: 'imDone', input: { handoff: 'Rate-limit audit: 3 routes unthrottled\nmore' } }, 42 * 60_000),
            tool({ id: 'h2', status: 'completed' }, 42 * 60_000),
        ];
        expect(deliveryFrom(done, NOW)).toMatchObject({ kind: 'handoff', main: 'handoff', sub: 'Rate-limit audit: 3 routes unthrottled', age: '42m' });
    });

    it('the NEWEST wins: a file after a commit is the delivery', () => {
        const rows = [
            tool({ id: 'c1', name: 'Bash', kind: 'execute', input: { command: 'git commit -m "a"' } }, 600_000),
            tool({ id: 'c1', status: 'completed', output: '[main 1234567] a' }, 600_000),
            tool({ id: 'e2', name: 'Write', kind: 'edit', input: { file_path: 'CHANGELOG.md', content: 'x' } }, 120_000),
            tool({ id: 'e2', status: 'completed' }, 120_000),
        ];
        expect(deliveryFrom(rows, NOW)).toMatchObject({ kind: 'file', main: 'CHANGELOG.md', age: '2m' });
    });

    it('nothing delivered yet: its answer, else nothing (CONTROL: reads and searches are not deliveries)', () => {
        expect(deliveryFrom([said('withTools() has 14 call sites\n\nDetails…', 7 * 60_000)], NOW)).toMatchObject({ kind: 'answer', main: 'withTools() has 14 call sites', age: '7m' });
        const reads = [tool({ id: 'r1', name: 'Read', kind: 'read', input: { file_path: 'a.ts' } }, 5_000), tool({ id: 'r1', status: 'completed' }, 4_000)];
        expect(deliveryFrom(reads, NOW)).toBeNull();
        expect(deliveryFrom([], NOW)).toBeNull();
    });
});
