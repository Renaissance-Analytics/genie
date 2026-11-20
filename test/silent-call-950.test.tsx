import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SILENT_CALL_MS, silentCall, silentCallWords, type RunningCall } from '../src/core/hung-call.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { SilentCall } from '../src/renderer/components/SilentCall.js';
import { Stream } from '../src/renderer/components/Stream.js';

/**
 * THE HEADER NEVER SHOWS THE RUNNING COMMAND; A SILENT CALL SHOWS IN THE STREAM (Tynn #950). The owner on beta.65: "I don't
 * need to see the workstream in the freaking header." #855 put the running call — its whole command, "under a minute" and
 * Stop this call — in the agent's bar on EVERY call. The bar now carries the agent's state only. A call that has printed
 * nothing for 2 minutes shows at its OWN entry in the stream: its name, how long it has been silent, and Stop this call.
 * #855's stop, its 15-minute no-output timeout and Stalled are unchanged (hung-turn-855*.test.ts still pin them).
 */

const MIN = 60_000;
const COMMAND = 'gh pr create --fill --base next/host-split-tms';
const call: RunningCall = { toolCallId: 'c1', label: 'Bash', command: COMMAND, since: 10 * MIN };

describe('silentCall (core)', () => {
    it('is 2 minutes', () => {
        expect(SILENT_CALL_MS).toBe(2 * MIN);
    });

    it('no call, no silent call', () => {
        expect(silentCall(null, null, 60 * MIN)).toBeNull();
        expect(silentCall(undefined, undefined, 60 * MIN)).toBeNull();
    });

    it('a call under 2 minutes old is not silent, however quiet the turn', () => {
        expect(silentCall(call, null, 10 * MIN + 2 * MIN - 1)).toBeNull();
        expect(silentCall(call, 0, 10 * MIN + 2 * MIN - 1)).toBeNull();
    });

    it('a call with nothing since it began for 2 minutes is silent: its id, its name, how long', () => {
        expect(silentCall(call, null, 13 * MIN)).toEqual({ toolCallId: 'c1', label: 'Bash', silentMs: 3 * MIN });
        // An event from BEFORE the call does not shorten its silence.
        expect(silentCall(call, 5 * MIN, 13 * MIN)).toEqual({ toolCallId: 'c1', label: 'Bash', silentMs: 3 * MIN });
    });

    it('output from the call resets its silence: measured from the later of its start and the last event', () => {
        // Started 10 min, printed at 20 min; at 21 min it has been silent one minute, not eleven.
        expect(silentCall(call, 20 * MIN, 21 * MIN)).toBeNull();
        expect(silentCall(call, 20 * MIN, 22 * MIN + 30_000)).toEqual({ toolCallId: 'c1', label: 'Bash', silentMs: 2.5 * MIN });
    });

    it('its words: how long it has printed nothing, never the command', () => {
        expect(silentCallWords({ toolCallId: 'c1', label: 'Bash', silentMs: 3 * MIN })).toBe('No output for 3 min');
        expect(silentCallWords({ toolCallId: 'c1', label: 'Bash', silentMs: 2 * MIN + 59_000 })).toBe('No output for 2 min');
    });
});

const silent = { toolCallId: 'c1', label: 'Bash', silentMs: 4 * MIN };

describe('SilentCall (the stream entry)', () => {
    it('names the call and its silence, with Stop this call, as react-fancy parts', () => {
        const html = renderToStaticMarkup(<SilentCall call={silent} onStop={() => {}} />);
        expect(html).toContain('data-silent-call="c1"');
        expect(html).toContain('Bash');
        expect(html).toContain('No output for 4 min');
        const stop = /<button\b[^>]*data-action="stop-call"[^>]*>/.exec(html)?.[0] ?? '';
        expect(stop, 'Stop this call is a button').not.toBe('');
        expect(html).toMatch(/data-action="stop-call"[^>]*>(?:(?!<\/button>)[\s\S])*Stop this call/);
        expect(html).toContain('data-react-fancy-callout');
    });

    it('a window that cannot act (a read-only share) sees the silence and no button', () => {
        const html = renderToStaticMarkup(<SilentCall call={silent} />);
        expect(html).toContain('No output for 4 min');
        expect(html).not.toContain('data-action="stop-call"');
    });

    it('pressing Stop this call stops that call, once', () => {
        const onStop = vi.fn();
        const found: Array<() => void> = [];
        const walk = (node: unknown): void => {
            if (node === null || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(walk); return; }
            const el = node as { type?: unknown; props?: { onClick?: () => void; children?: unknown; 'data-action'?: string } };
            if (el.props?.['data-action'] === 'stop-call' && el.props.onClick) found.push(el.props.onClick);
            walk(el.props?.children);
        };
        walk(SilentCall({ call: silent, onStop }));
        expect(found).toHaveLength(1);
        found[0]!();
        expect(onStop).toHaveBeenCalledTimes(1);
    });
});

const t = (id: string, event: StreamEvent, at = 1_000): TimedEvent => ({ id, event, at });
const bash = (id: string, toolCallId: string, command: string, status: 'in_progress' | 'completed'): TimedEvent =>
    t(id, { kind: 'tool', toolCallId, name: 'Bash', title: null, status, toolKind: 'execute', rawInput: { command } } as StreamEvent);
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    bash('a1:1', 'c0', 'git status', 'completed'),
    bash('a1:2', 'c1', COMMAND, 'in_progress'),
    t('a1:3', { kind: 'message', speaker: 'agent', peerName: null, text: 'waiting on gh' }),
];

describe('the Stream shows the silent call at its own entry', () => {
    it('right after that call\'s row, and nowhere else', () => {
        const html = renderToStaticMarkup(<Stream rows={rows} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="atlas" silentCall={{ call: silent, onStop: () => {} }} />);
        const entry = html.indexOf('data-silent-call="c1"');
        expect(entry, 'the silent call is in the stream').toBeGreaterThan(-1);
        // After c1's row (a1:2), before the row that follows it (a1:3), and after the earlier call (a1:1).
        expect(html.indexOf('data-stream-row="a1:2"')).toBeLessThan(entry);
        expect(html.indexOf('data-stream-row="a1:1"')).toBeLessThan(entry);
        expect(entry).toBeLessThan(html.indexOf('data-stream-row="a1:3"'));
        expect(html.match(/data-silent-call=/g)).toHaveLength(1);
        expect(html).toContain('data-action="stop-call"');
    });

    it('CONTROL: no silent call, no entry; a silent call whose row is not shown, no stray entry', () => {
        const none = renderToStaticMarkup(<Stream rows={rows} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="atlas" />);
        expect(none).toContain('data-stream-row="a1:2"');
        expect(none).not.toContain('data-silent-call');
        const other = renderToStaticMarkup(<Stream rows={rows} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="atlas" silentCall={{ call: { ...silent, toolCallId: 'gone' } }} />);
        expect(other).not.toContain('data-silent-call');
    });
});

const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/ws', instructions: null };
const working = (lastEventAt: number | null): LiveSession => ({
    running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
    lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, call, lastEventAt,
}) as LiveSession;

/** The agent view, and its bar's own markup (what the `bar` slot is handed) rendered on its own. */
function view(session: LiveSession, now: number, withRows: readonly TimedEvent[]): { page: string; bar: string } {
    let trailing: ReactNode = null;
    const page = renderToStaticMarkup(
        <AgentView agent={agent} session={session} rows={withRows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null}
            onNavigate={() => {}} onSelect={() => {}} now={() => now} onStopToolCall={() => {}} workspace={{ id: 'ws', name: 'ws', path: '/w/ws' }}
            bar={(t) => { trailing = t; return <div data-probe-bar="" />; }} />,
    );
    return { page, bar: renderToStaticMarkup(<>{trailing}</>) };
}

describe('the agent view (Tynn #950)', () => {
    it('the bar carries no command text, no call age and no Stop this call — while the call is fresh', () => {
        const { page, bar } = view(working(null), 10 * MIN + 30_000, []);
        // POSITIVE CONTROL: the bar was captured, and it holds the state pill.
        expect(bar).toContain('data-pill=');
        for (const html of [bar, page]) {
            expect(html).not.toContain('gh pr create');
            expect(html).not.toContain('under a minute');
            expect(html).not.toContain('data-running-call');
            expect(html).not.toContain('data-action="stop-call"');
        }
    });

    it('…and while it is silent: the bar still says nothing of it; the stream shows it, with Stop this call', () => {
        const { page, bar } = view(working(null), 15 * MIN, rows);
        expect(bar).toContain('data-pill=');
        expect(bar).not.toContain('gh pr create');
        expect(bar).not.toContain('data-silent-call');
        expect(bar).not.toContain('data-action="stop-call"');
        expect(page).toContain('data-silent-call="c1"');
        expect(page).toContain('No output for 5 min');
        expect(page).toContain('data-action="stop-call"');
    });

    it('CONTROL: a call that printed a minute ago is not silent, so nothing shows in the stream', () => {
        const { page } = view(working(14 * MIN), 15 * MIN, rows);
        expect(page).toContain('data-stream-row="a1:2"');
        expect(page).not.toContain('data-silent-call');
    });
});
