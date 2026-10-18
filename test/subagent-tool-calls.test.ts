import { ClaudeToAcp } from '@particle-academy/prism-acp';
import { describe, expect, it } from 'vitest';
import { toStreamEvent } from '../src/core/stream-event.js';
import { activityRows, ledgerRow, type TimedEvent } from '../src/core/stream-view.js';

/**
 * A SUBAGENT'S TOOL CALLS HAVE NAMES (the owner, 2026-10-18, a screenshot of a Stream full of bare "(tool call)" rows:
 * "why do I get a lot of stuff like these tool calls? it's not helpful since it has no details").
 *
 * Measured by the prism agent with the real Claude Code CLI (2.1.301): a subagent's tool_use blocks (the Task/Agent
 * tool's inner calls) arrive ONLY as whole `assistant` frames carrying `parent_tool_use_id` — never as stream events —
 * while their results arrive as `user` frames with the same parent. prism-acp 0.16.0 announced a call only from stream
 * events, so each inner call reached Genie as a result with no call: a row with no name, no title, no arguments.
 * prism-acp 0.17.0 announces it from the assistant frame, whole, with its parent.
 *
 * The frames below are that turn's shapes, run through the real mapper and Genie's own rows.
 */
const AGENT = 'toolu_agent_1';
const read = (id: string, file: string) => [
    { type: 'assistant', parent_tool_use_id: AGENT, message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } },
    { type: 'user', parent_tool_use_id: AGENT, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `contents of ${file}` }] } },
];
const FRAMES = [
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_main', usage: {} } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: AGENT, name: 'Agent' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"prompt":"Read a.txt, b.txt and c.txt"}' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } },
    ...read('toolu_r1', 'a.txt'),
    ...read('toolu_r2', 'b.txt'),
    ...read('toolu_r3', 'c.txt'),
    { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: AGENT, content: 'done' }] } },
];

function streamRows(): TimedEvent[] {
    const mapper = new ClaudeToAcp();
    const rows: TimedEvent[] = [];
    let i = 0;
    for (const frame of FRAMES) {
        for (const update of mapper.frame(frame)) {
            const event = toStreamEvent(update as unknown as Record<string, unknown>);
            if (event) rows.push({ id: `r${i}`, at: i++, event });
        }
    }
    return activityRows(rows);
}

describe('a subagent’s tool calls in the Stream', () => {
    it('each inner call is ONE row with its name and its argument — COUNTED: the Agent call and its three Reads', () => {
        const tools = streamRows().filter((r) => r.event.kind === 'tool');
        expect(tools.map((r) => (r.event as { name: string | null }).name)).toEqual(['Agent', 'Read', 'Read', 'Read']);
        const mains = tools.map((r) => ledgerRow(r).main);
        expect(mains.slice(1)).toEqual([expect.stringContaining('a.txt'), expect.stringContaining('b.txt'), expect.stringContaining('c.txt')]);
    });

    it('no row is the bare "(tool call)" the owner saw, and every inner call ended completed', () => {
        const rows = streamRows().filter((r) => r.event.kind === 'tool');
        expect(rows.map((r) => ledgerRow(r).main)).not.toContain('(tool call)');
        expect(rows.slice(1).map((r) => (r.event as { status: string | null }).status)).toEqual(['completed', 'completed', 'completed']);
    });
});
