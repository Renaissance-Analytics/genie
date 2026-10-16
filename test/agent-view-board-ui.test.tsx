import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * THE AGENT VIEW'S HEADER AND RIGHT COLUMN PER THE BOARD. Header: `{workspace} /` breadcrumb, the fidelity dot, the
 * name, a provider chip (`claude · ACP` / `aider · pty`), the pill in the board's words, then the actions with their
 * chords (`Take over ⌘⇧T`, `Chat ⌘J`), `Stop this turn` while a turn runs that can be stopped, `Restart` only when broken. Right column: ONE 380px
 * panel holding the Inspector (when a row is selected) above Plan / Context / Cost — not a 420px Inspector beside a
 * 260px rail.
 */
const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
const workspace = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const running: LiveSession = { running: true, turnState: 'working', startedAt: 1_000_000 - 10_000, pendingApproval: null, failure: null, contextUsed: 38_000, contextSize: 200_000, plan: { step: 4, of: 7, doing: 'Passkey enrolment endpoint' } } as LiveSession;
const broken: LiveSession = { ...running, running: false, turnState: 'failed', failure: { reason: 'ACP stream closed · exit 137', fixes: ['Restart'] } };
const ops: AgentOpsProps = { mode: 'manual', accessScope: 'self', budgetUsd: null, deletePreview: null, diagnosis: null, lastOutcome: null, onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetMode: () => {}, onSetAccessScope: () => {}, onSetBudget: () => {} } as unknown as AgentOpsProps;
const toolRow: TimedEvent = { id: 'e1', at: 1_000, event: { kind: 'tool', toolKind: 'execute', name: 'Bash', title: 'php artisan test', status: 'completed', rawInput: '{"command":"php artisan test"}', rawOutput: null, locations: [] } as never };
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={running} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={14} cost={null} onNavigate={() => {}} onSelect={() => {}} onTakeOver={() => {}} now={() => 1_000_000} workspace={workspace} {...props} />);

describe('the header', () => {
    it('breadcrumb, fidelity dot, name, provider chip, the pill in turns', () => {
        const html = render();
        expect(html).toMatch(/data-crumb="tynn"[^>]*>Tynn\.ai \//);
        expect(html).toContain('data-fidelity="declared"');
        expect(html).toMatch(/data-provider-chip="claude"[^>]*>claude · ACP</);
        expect(html).toContain('data-pill="Turn 14 · running"');
        const observed = render({ agent: { ...agent, fidelity: 'observed', provider: 'aider' }, session: null, tab: 'activity', takeOver: { terminalId: 't', startedAt: 0, lastOutputAt: 1_000_000 - 10_000, bursts: [] } });
        expect(observed).toMatch(/data-provider-chip="aider"[^>]*>aider · pty</);
        expect(observed).toContain('data-pill="Active · last output 10s ago"');
    });

    it('actions by state: Stop this turn while running, Restart only when broken, chords on Take over and Chat; the kebab keeps the other verbs', () => {
        const live = render({ ops, session: { ...running, cancelTurn: true }, onCancelTurn: () => {} });
        expect(live.split('data-action="stop-turn"').length - 1).toBe(1);
        expect(live).not.toContain('data-action="restart-graceful"');
        expect(live).toMatch(/data-action="take-over"[^>]*>[^<]*(<[^>]*>[^<]*)*⌘⇧T/);
        expect(live).toMatch(/data-action="chat"[^>]*>[^<]*(<[^>]*>[^<]*)*⌘J/);
        expect(live).toContain('data-action="agent-more"');
        const dead = render({ ops, session: broken });
        expect(dead).toContain('data-action="restart-graceful"');
        expect(dead).toContain('data-action="open-terminal"');
        expect(dead).not.toContain('data-action="stop-turn"');
        expect(dead).toContain('data-pill="Broken · ACP stream closed · exit 137"');
    });
});

describe('the right column', () => {
    it('is ONE 380px panel: the Inspector above Plan and Context when a row is selected; Plan and Context alone otherwise; absent before the first turn', () => {
        const withInspector = render({ rows: [toolRow], selectedId: 'e1' });
        expect((withInspector.match(/data-right-column/g) ?? []).length).toBe(1);
        expect(withInspector).toMatch(/data-right-column[^>]*class="[^"]*w-\[380px\]/);
        expect(withInspector).not.toMatch(/w-\[420px\]/);
        expect(withInspector).not.toMatch(/w-\[260px\]/);
        expect(withInspector).toMatch(/data-right-column[^]*data-inspector=[^]*data-rail="plan"/);
        const plain = render();
        expect(plain).toContain('data-rail="plan"');
        expect(plain).not.toContain('data-inspector=');
        expect(render({ session: null, turns: 0 })).not.toContain('data-right-column');
    });
});
