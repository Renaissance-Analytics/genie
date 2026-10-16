import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * AN OBSERVED AGENT HAS A WORKING VIEW. The board audit of 2026-10-12: Terminal and Activity were tabs over an empty
 * area — a TUI the user opened via Take Over had no page at all. Terminal is that TUI's terminal, attached here as
 * a second view of the same pty (§6.5 multi-attach); Activity is what Genie measured — twelve bars, when it last
 * printed, the bursts — and nothing it did not.
 */
const agent = { id: 'o1', name: 'moth', provider: 'aider', fidelity: 'observed' as const, cwd: '/w/tynn' };
const takeOver = { terminalId: 't-77', startedAt: 1_000, lastOutputAt: 60_000, bursts: [{ at: 50_000, bytes: 2_048 }, { at: 60_000, bytes: 100 }] };
const render = (props: Partial<Parameters<typeof AgentView>[0]>) =>
    renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="terminal" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 100_000} {...props} />);

describe('the Terminal tab (observed)', () => {
    it('mounts the TUI’s terminal by its id — a second attach to the same pty, not a new shell', () => {
        const html = render({ tab: 'terminal', takeOver, terminals: NO_TERMINALS });
        expect(html).toContain('data-observed-terminal="t-77"');
        expect(html).not.toContain('data-tab-unavailable');
    });

    it('says so when the Take Over window is gone or this window has no terminal host — a sentence, not a blank', () => {
        expect(render({ tab: 'terminal', takeOver: null, terminals: NO_TERMINALS })).toContain('data-tab-unavailable="terminal"');
        expect(render({ tab: 'terminal', takeOver })).toContain('data-tab-unavailable="terminal"');
    });
});

describe('the Activity tab (observed)', () => {
    it('draws the twelve bars, when it last printed, and one ledger row per burst — newest first', () => {
        const html = render({ tab: 'activity', takeOver, terminals: NO_TERMINALS });
        expect(html).toContain('data-observed-activity="o1"');
        expect((html.match(/data-activity-bar="/g) ?? []).length).toBe(12);
        expect(html).toContain('last output 40s ago');
        const bursts = [...html.matchAll(/data-activity-burst="(\d+)"/g)].map((m) => Number(m[1]));
        expect(bursts).toEqual([60_000, 50_000]);
        expect(html).toContain('output burst · 2.0 kB');
    });

    it('no Take Over: a sentence; no bursts: the bars (a measured nothing) and no ledger rows', () => {
        expect(render({ tab: 'activity', takeOver: null })).toContain('data-tab-unavailable="activity"');
        const quiet = render({ tab: 'activity', takeOver: { ...takeOver, lastOutputAt: null, bursts: [] } });
        expect((quiet.match(/data-activity-bar="/g) ?? []).length).toBe(12);
        expect(quiet).toContain('no output yet');
        expect(quiet).not.toContain('data-activity-burst');
    });
});
