import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PULSE_SLOTS, PULSE_TICK_MS, agentPulse, pulseTickMs } from '../src/core/agent-pulse.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentPulse } from '../src/renderer/components/AgentPulse.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE AGENT PULSE (beta.64, the owner): the SESSION lane bar is gone from the Stream, and the agent view carries a
 * pulse like Genie 1's sidebar one: the last minute of the agent's work as a sparkline, with markers for edits, mail
 * and questions. Cheaper than Genie 1's: derived from the rows the view already holds (no buffer), a scan bounded by
 * the minute, a tick every 2 s only while something can move, and nothing at all for an idle agent.
 */
const NOW = 1_000_000;
const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
const tool = (id: string, at: number | null, toolKind = 'execute'): TimedEvent =>
    t(id, { kind: 'tool', toolCallId: id, name: 'Bash', title: null, status: 'completed', toolKind, rawInput: null } as StreamEvent, at);
const edit = (id: string, at: number): TimedEvent =>
    t(id, { kind: 'tool', toolCallId: id, name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } } as StreamEvent, at);
const think = (id: string, at: number): TimedEvent => t(id, { kind: 'think', text: 'hm', tokens: null } as StreamEvent, at);
const turn = (id: string, at: number): TimedEvent => t(id, { kind: 'turn', n: 1, by: 'you' }, at);
const mail = (id: string, at: number): TimedEvent => t(id, { kind: 'message', speaker: 'peer', peerName: 'moic', text: 'hi' }, at);
const asked = (id: string, at: number): TimedEvent => t(id, { kind: 'approval', question: 'Run it?', tool: null, outcome: 'allowed', optionId: null }, at);

describe('agentPulse: the last minute, from the rows', () => {
    it('counts each event into its 2-second slot; the newest slot is the last', () => {
        const p = agentPulse([tool('a', NOW - 59_000), think('b', NOW - 3_000), tool('c', NOW - 500), tool('d', NOW - 100)], NOW);
        expect(p.counts).toHaveLength(PULSE_SLOTS);
        expect(p.counts[0]).toBe(1);
        expect(p.counts[PULSE_SLOTS - 2]).toBe(1);
        expect(p.counts[PULSE_SLOTS - 1]).toBe(2);
        expect(p.counts.reduce((a, b) => a + b, 0)).toBe(4);
        expect(p.quiet).toBe(false);
    });

    it('leaves out what is not work: turn markers, untimed rows, and anything older than the minute', () => {
        const p = agentPulse([tool('old', NOW - 61_000), turn('t', NOW - 1_000), tool('untimed', null), tool('ok', NOW - 1_000)], NOW);
        expect(p.counts.reduce((a, b) => a + b, 0)).toBe(1);
        const none = agentPulse([tool('old', NOW - 61_000), turn('t', NOW - 1_000)], NOW);
        expect(none.quiet).toBe(true);
        expect(none.markers).toEqual([]);
    });

    it('marks edits, mail from another agent and questions in their slots, counted, never dropped', () => {
        const p = agentPulse([edit('e1', NOW - 1_000), edit('e2', NOW - 900), mail('m', NOW - 10_000), asked('q', NOW - 10_000)], NOW);
        expect(p.markers).toContainEqual({ slot: PULSE_SLOTS - 1, kind: 'edit', n: 2 });
        expect(p.markers).toContainEqual({ slot: PULSE_SLOTS - 5 - 1, kind: 'mail', n: 1 });
        expect(p.markers).toContainEqual({ slot: PULSE_SLOTS - 5 - 1, kind: 'question', n: 1 });
        expect(p.markers).toHaveLength(3);
    });

    it('reads back only as far as the minute: a long session costs what its last minute costs', () => {
        const old = Array.from({ length: 5_000 }, (_, i) => tool(`o${i}`, NOW - 3_600_000 + i));
        const rows = [...old, tool('n1', NOW - 2_000), tool('n2', NOW - 1_000)];
        let reads = 0;
        const counted = new Proxy(rows, {
            get(target, key, receiver) {
                if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
                return Reflect.get(target, key, receiver);
            },
        });
        const p = agentPulse(counted, NOW);
        expect(p.counts.reduce((a, b) => a + b, 0)).toBe(2);
        expect(reads).toBeLessThanOrEqual(4);
    });
});

describe('pulseTickMs: a clock only while something can move', () => {
    const quiet = agentPulse([], NOW);
    const busy = agentPulse([tool('a', NOW - 1_000)], NOW);
    it('an idle agent with a quiet minute gets no clock at all', () => {
        expect(pulseTickMs(quiet, false, true)).toBeNull();
    });
    it('a working agent, or a minute still holding events, ticks every 2 s', () => {
        expect(pulseTickMs(quiet, true, true)).toBe(PULSE_TICK_MS);
        expect(pulseTickMs(busy, false, true)).toBe(PULSE_TICK_MS);
        expect(PULSE_TICK_MS).toBe(2_000);
    });
    it('a hidden window ticks for nobody', () => {
        expect(pulseTickMs(busy, true, false)).toBeNull();
    });
});

describe('<AgentPulse>', () => {
    it('keeps its fixed slot when quiet (no layout jump) and draws no line', () => {
        const html = renderToStaticMarkup(<AgentPulse rows={[]} working={false} now={() => NOW} />);
        expect(html).toMatch(/data-agent-pulse="quiet"[^>]*class="[^"]*w-\[120px\][^"]*h-5/);
        expect(html).not.toContain('<svg');
    });
    it('draws the minute with react-fancy’s sparkline, and the markers on it', () => {
        const html = renderToStaticMarkup(<AgentPulse rows={[tool('a', NOW - 5_000), edit('e', NOW - 1_000)]} working now={() => NOW} />);
        expect(html).toMatch(/data-agent-pulse="working"[^>]*class="[^"]*w-\[120px\][^"]*h-5/);
        expect(html).toContain('data-react-fancy-chart-sparkline');
        expect(html).toMatch(/data-pulse-marker="edit"[^>]*data-count="1"/);
    });
    it('no per-frame work: no animation frames and no endless CSS animation', () => {
        const src = readFileSync('src/renderer/components/AgentPulse.tsx', 'utf8');
        expect(src).not.toMatch(/requestAnimationFrame|animate-|@keyframes/);
        expect(src).toContain('pulseTickMs(');
    });
});

const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const viewRows: TimedEvent[] = [turn('t1', NOW - 5_000), edit('e1', NOW - 4_000), think('th', NOW - 3_000)];
const view = (tab: 'stream' | 'shells') =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={viewRows} tab={tab} lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => NOW} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} />);

describe('the agent view', () => {
    it('no SESSION lane bar on the Stream: no strip, no legend, no Next edit, no Turns door, no Lanes button', () => {
        const html = view('stream');
        for (const gone of ['data-session-timeline', 'data-legend=', 'data-action="next-edit"', 'data-action="toggle-layout"', 'data-action="toggle-lanes"']) expect(html).not.toContain(gone);
        // The chips row (the lane filter) stays.
        expect(html).toContain('data-chips');
    });
    it('the pulse sits in the tab row, on every tab', () => {
        for (const tab of ['stream', 'shells'] as const) expect(view(tab)).toMatch(/role="tablist"[\s\S]*data-agent-pulse="working"/);
    });
});
