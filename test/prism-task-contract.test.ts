import { ClaudeToAcp } from '@particle-academy/prism-acp';
import { describe, expect, it } from 'vitest';
import { agentShells } from '../src/core/agent-shells.js';
import { toStreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE SHELLS TAB AGAINST PRISM-ACP'S REAL MAPPER — Claude's stream-json frames, as documented in the Agent SDK
 * reference, through `ClaudeToAcp` (the installed package), through Genie's `toStreamEvent`, into `agentShells`.
 * Genie's own tests feed `agentShells` the shapes Genie expects; this one feeds it what prism actually sends, so a
 * difference between the two (a renamed key, a field on a different update) fails here instead of in front of the owner.
 *
 * Two facts it pins:
 * - prism-acp 0.12.0 maps the task frames (0.11 dropped them: a running shell read as "not reported");
 * - a tool's NAME rides the first `tool_call` and its INPUT the later `tool_call_update` (which has no name).
 */

function feed(frames: readonly unknown[]): TimedEvent[] {
    const mapper = new ClaudeToAcp();
    const rows: TimedEvent[] = [];
    let at = 1000;
    for (const frame of frames) {
        for (const update of mapper.frame(frame)) {
            const event = toStreamEvent(update as Record<string, unknown>);
            if (event) rows.push({ id: `r${rows.length}`, event, at: at++ });
        }
    }
    return rows;
}

const toolUse = (index: number, id: string, name: string, input: Record<string, unknown>) => [
    { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index } },
];
const system = (subtype: string, body: Record<string, unknown>) => ({ type: 'system', subtype, uuid: `u-${subtype}`, session_id: 's1', ...body });

describe('Claude → prism-acp → Genie: the Shells tab', () => {
    it('a background Bash call joined to its task: running with its command, then completed with Claude\'s summary', () => {
        const started = [
            ...toolUse(0, 'toolu_1', 'Bash', { command: 'npm run dev', description: 'dev server', run_in_background: true }),
            system('task_started', { task_id: 'b1', tool_use_id: 'toolu_1', description: 'dev server', task_type: 'local_bash', is_backgrounded: true }),
            system('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'dev server' }] }),
        ];
        const now = agentShells(feed(started));
        expect(now.reported).toBe(true);
        expect(now.count).toBe(1);
        expect(now.running).toEqual([expect.objectContaining({ key: 'b1', kind: 'shell', command: 'npm run dev', state: 'running' })]);

        const later = agentShells(feed([
            ...started,
            system('task_notification', { task_id: 'b1', tool_use_id: 'toolu_1', status: 'completed', output_file: '/tmp/b1.output', summary: 'dev server exited 0' }),
            system('background_tasks_changed', { tasks: [] }),
        ]));
        expect(later.count).toBe(0);
        expect(later.ended).toEqual([expect.objectContaining({ key: 'b1', command: 'npm run dev', state: 'completed', summary: 'dev server exited 0', outputFile: '/tmp/b1.output' })]);
    });

    it('a terminal opened through Genie is listed — its name came on the call, its input on the update', () => {
        const s = agentShells(feed(toolUse(0, 'toolu_9', 'mcp__genie__manageTerminals', { action: 'create', command: 'php artisan serve' })));
        expect(s.terminals).toEqual([{ key: 'toolu_9', command: 'php artisan serve', at: expect.any(Number) }]);
    });
});
