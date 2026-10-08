import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession, type ToolCall } from '../../../main/agentsession/model';
import { agentStream, EVENT_KIND_ICON, type StreamRow } from '../agent-stream';

/**
 * THE STREAM — §5.2 of the owner's spec board, "total oversight".
 *
 * One ordered list of two row shapes, and the distinction is the whole design:
 *
 *  - **SPEECH** wraps and renders in full. It is what the human came to read.
 *  - **EVENT** is exactly ONE LINE, always — thoughts, tool calls, edits, plan moves, usage.
 *
 * The brief's fixed rule is that a thought is one line with its cost and is NEVER
 * auto-expanded, because content jumping as reasoning streams is the worst reading experience
 * in agent UIs. The usual implementation of that is "collapse long things", which fails: the
 * collapsed thing still reflows when it streams. The board's fix is structural — an EVENT row
 * cannot grow — and that is a property this projection can guarantee rather than a style the
 * component has to remember.
 */

const NOW = 1_000_000;

function session(over: Partial<AgentSession> & { agentId?: string } = {}): AgentSession {
    const base = emptyAgentSession(
        {
            agentId: over.agentId ?? 'atlas',
            specId: 'spec-1',
            provider: 'claude',
            name: 'atlas',
            cwd: '/w',
            workspaceId: 'tynn',
        },
        NOW,
    );
    return { ...base, ...over, session: { ...base.session, ...(over.session ?? {}) } };
}

const tool = (over: Partial<ToolCall> = {}): ToolCall => ({
    id: 't1',
    name: 'Read',
    status: 'success',
    kind: 'read',
    rawInput: { file_path: '/w/src/Auth/ChallengeStore.php' },
    result: null,
    at: NOW,
    ...over,
});

const events = (rows: StreamRow[]) => rows.filter((r) => r.type === 'event');

describe('an EVENT row is one line, always — and the projection guarantees it', () => {
    it('flattens a multi-line thought into a single line', () => {
        /**
         * THE CENTRAL PROPERTY. Reasoning arrives with newlines in it, frequently, and a row
         * that grows to three lines when the fourth chunk lands is exactly the content-jumping
         * the rule forbids. Guaranteed HERE rather than left to CSS: `white-space: nowrap` in
         * a stylesheet is one careless override away from being lost, and nothing would fail.
         */
        const s = session({
            thoughts: [
                { id: 'th1', text: 'No sign-count column.\nEither add a migration\n\nor ask wren…', at: NOW },
            ],
        });
        const row = events(agentStream(s, { now: NOW }))[0]!;
        expect(row.main).not.toContain('\n');
        expect(row.main).toBe('No sign-count column. Either add a migration or ask wren…');
    });

    it('collapses runs of whitespace, so a wrapped source line does not become a gap', () => {
        const s = session({ thoughts: [{ id: 'th1', text: 'a\n\n\n   \tb', at: NOW }] });
        expect(events(agentStream(s, { now: NOW }))[0]!.main).toBe('a b');
    });

    it('leaves SPEECH alone, because speech is meant to wrap', () => {
        // The other half of the rule. Flattening a reply would destroy paragraphs in the one
        // place a human is actually reading prose.
        const s = session({
            transcript: [
                { id: 'm1', role: 'agent', author: null, content: 'First line.\n\nSecond line.', at: NOW },
            ],
        });
        const row = agentStream(s, { now: NOW }).find((r) => r.type === 'speech')!;
        expect(row.main).toBe('First line.\n\nSecond line.');
    });
});

describe('a LIVE thought shows that it is thinking, never what it is thinking', () => {
    it('renders the placeholder and withholds the text', () => {
        /**
         * The board: a streaming thought reads `· thinking…` with the count ticking and *"the
         * text never appearing"*. Withholding it is the point — the text is only legible once
         * it has settled, and showing it as it arrives is the jumping the whole design avoids.
         */
        const s = session({ liveThought: { id: 'th-live', text: 'half a sentence that will ch', at: NOW } });
        const row = events(agentStream(s, { now: NOW })).find((r) => r.live)!;
        expect(row.main).toBe('Thinking…');
        expect(row.main).not.toContain('half a sentence');
    });

    it('shows a settled thought’s text, because by then it stops moving', () => {
        // The positive control for the case above: withholding ALWAYS would make the stream
        // useless for the thing §5.2 exists to provide.
        const s = session({ thoughts: [{ id: 'th1', text: 'Controller should stay thin…', at: NOW }] });
        expect(events(agentStream(s, { now: NOW }))[0]!.main).toBe('Controller should stay thin…');
    });

    it('fabricates no token count for a thought', () => {
        // Not on the wire — see `Thought`. The board draws `842 tok`; producing one here would
        // mean estimating from character count, which is an estimate dressed as a measurement.
        const s = session({ thoughts: [{ id: 'th1', text: 'x'.repeat(4000), at: NOW }] });
        expect(events(agentStream(s, { now: NOW }))[0]!.meta).toBeNull();
    });
});

describe('tool rows say what the tool did', () => {
    it('names the file an edit touched', () => {
        const s = session({
            tools: [tool({ id: 'e1', name: 'Edit', kind: 'edit', rawInput: { file_path: '/w/routes/api.php' } })],
        });
        const row = events(agentStream(s, { now: NOW }))[0]!;
        expect(row.kind).toBe('edit');
        expect(row.main).toBe('api.php');
        expect(EVENT_KIND_ICON.edit).toBe('pencil');
    });

    it('distinguishes a READ from an edit, because the board draws them differently', () => {
        // An edit is tinted and counts toward "what changed"; a read is traffic. Same row
        // shape, different kind — and the kind comes from the agent, never from the name.
        const s = session({ tools: [tool({ kind: 'read' })] });
        expect(events(agentStream(s, { now: NOW }))[0]!.kind).toBe('tool');
    });

    it('marks a FAILED call, so a red row has a cause', () => {
        const s = session({ tools: [tool({ status: 'failure', name: 'Bash', kind: 'execute' })] });
        const row = events(agentStream(s, { now: NOW }))[0]!;
        expect(row.level).toBe('bad');
    });

    it('marks a call still RUNNING, which is not the same as failed', () => {
        const s = session({ tools: [tool({ status: 'pending' })] });
        expect(events(agentStream(s, { now: NOW }))[0]!.level).toBe('pending');
    });

    it('falls back to the tool NAME when there is no subject to show', () => {
        // Not a blank row. The name is the least Genie always knows, and a row with nothing in
        // it reads as a rendering fault rather than as a tool with opaque arguments.
        const s = session({ tools: [tool({ name: 'WebSearch', kind: 'fetch', rawInput: null })] });
        expect(events(agentStream(s, { now: NOW }))[0]!.main).toBe('WebSearch');
    });
});

describe('ordering', () => {
    it('interleaves thoughts, tools and speech by WHEN THEY HAPPENED', () => {
        /**
         * The stream is one list, and its value is the sequence: a thought, then the tool it
         * led to, then what the agent said about the result. Three separate lists rendered one
         * after another would destroy exactly that.
         */
        const s = session({
            thoughts: [{ id: 'th1', text: 'check composer.json', at: NOW + 10 }],
            tools: [tool({ id: 't1', at: NOW + 20 })],
            transcript: [
                { id: 'm1', role: 'user', author: null, content: 'keep it thin', at: NOW },
                { id: 'm2', role: 'agent', author: null, content: 'done', at: NOW + 30 },
            ],
        });
        expect(agentStream(s, { now: NOW }).map((r) => r.main)).toEqual([
            'keep it thin',
            'check composer.json',
            'ChallengeStore.php',
            'done',
        ]);
    });

    it('puts a row with no timestamp at the END rather than at the epoch', () => {
        // `at: null` means unstamped, not 1970. Sorting it to the front would put the oldest
        // possible position on the newest possible fact.
        const s = session({
            thoughts: [{ id: 'th1', text: 'stamped', at: NOW + 50 }],
            tools: [tool({ id: 't1', at: null })],
        });
        const mains = events(agentStream(s, { now: NOW })).map((r) => r.main);
        expect(mains).toEqual(['stamped', 'ChallengeStore.php']);
    });

    it('keeps the LIVE rows last, because they are still happening', () => {
        const s = session({
            thoughts: [{ id: 'th1', text: 'settled', at: NOW }],
            liveThought: { id: 'th-live', text: 'in flight', at: NOW + 100 },
            live: { id: 'm-live', role: 'agent', author: null, content: 'speaking', at: NOW + 50 },
        });
        const rows = agentStream(s, { now: NOW });
        expect(rows[rows.length - 1]!.live).toBe(true);
    });
});

describe('what the stream says when it is empty or broken', () => {
    it('is empty for a new agent, rather than inventing a placeholder row', () => {
        expect(agentStream(session(), { now: NOW })).toEqual([]);
    });

    it('ends with the error when the stream closed', () => {
        const s = session({ error: 'ACP stream closed · exit 137', tools: [tool()] });
        const rows = agentStream(s, { now: NOW });
        const last = rows[rows.length - 1]!;
        expect(last.type).toBe('divider');
        expect(last.main).toContain('exit 137');
        expect(last.level).toBe('bad');
    });

    it('ends with a PARKED divider when the turn is waiting on a human', () => {
        // §6.4: the turn visibly parks. A stopped agent must be obvious in the stream, not
        // inferable from the absence of new rows.
        const s = session({
            turn: { state: 'awaiting-approval', since: NOW - 42_000 },
            approvals: [{ id: 'a1', name: 'Bash', args: {} }],
            tools: [tool()],
        });
        const rows = agentStream(s, { now: NOW });
        const last = rows[rows.length - 1]!;
        expect(last.type).toBe('divider');
        expect(last.main).toContain('parked');
        expect(last.level).toBe('attention');
    });

    it('does not park a turn that is merely idle', () => {
        // The positive control: every finished turn would otherwise end with a parked divider.
        const s = session({ turn: { state: 'idle', since: NOW }, tools: [tool()] });
        const rows = agentStream(s, { now: NOW });
        expect(rows.some((r) => r.main.includes('parked'))).toBe(false);
    });
});
