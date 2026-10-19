import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { tabsFor } from '../src/core/agent-view.js';
import { parseRoute } from '../src/core/route.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * AGENT SETTINGS ARE A TAB, NOT THE RAIL (Tynn #800). The owner, 2026-10-17, pointing at the rail (Persona, Mode, Budget,
 * Skills and commands): "the whole agent settings panel should be a settings tab on the agent screen, not this little
 * panel that is always in the way." The four sections move to a Settings tab, full width; the rail keeps only what is
 * LIVE (the plan, an ended process, an observed agent's terminal) and is absent when nothing is.
 */
const at = 1_760_000_000_000;
const session = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'idle', startedAt: at - 14_000, pendingApproval: null, failure: null,
    contextUsed: 120_000, contextSize: 200_000, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null,
    mcpServers: ['genie'], extensions: { commands: [{ name: 'genie', description: 'Genie tools' }], skills: [], plugins: [] },
    ...over,
} as LiveSession);
const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: 'repos/genie2', instructions: '.agents/kai/AGENT.md' };
const ops = { mode: 'automated' as const, onMode: () => {}, onRestart: () => {}, onDelete: () => {} } as never;

function render(tab: 'stream' | 'settings', over: Record<string, unknown> = {}): string {
    return renderToStaticMarkup(
        <AgentView agent={AGENT} session={session()} rows={[]} tab={tab} lanes={null} at={null} selectedId={null} turns={3} cost={1.25}
            onNavigate={() => {}} onSelect={() => {}} now={() => at} ops={ops} {...over} />,
    );
}

const SECTIONS = ['persona', 'mode', 'budget', 'extensions'] as const;

describe('the Settings tab', () => {
    it('a declared agent has a Settings tab, last; the route accepts ?tab=settings', () => {
        expect(tabsFor('declared').at(-1)).toBe('settings');
        expect(tabsFor('observed')).not.toContain('settings'); // CONTROL: an observed agent is not managed
        expect(parseRoute('genie://agent/kai?tab=settings')).toMatchObject({ surface: 'agent', tab: 'settings' });
        expect(render('stream')).toContain('data-tab="settings"');
    });

    it('on Settings: persona, mode, budget and skills are there, inside the full-width settings panel — each once', () => {
        const html = render('settings');
        const panel = html.slice(html.indexOf('data-agent-settings'));
        expect(html.indexOf('data-agent-settings')).toBeGreaterThan(-1);
        for (const s of SECTIONS) expect(panel.split(`data-rail="${s}"`).length - 1).toBe(1);
    });

    it('on the Stream: NONE of them is in the rail any more — the rail is not in the way', () => {
        const html = render('stream');
        for (const s of SECTIONS) expect(html).not.toContain(`data-rail="${s}"`);
        // With nothing live (no plan, nothing ended) there is no rail at all.
        expect(html).not.toContain('data-right-column=""');
    });

    it('CONTROL: what is LIVE stays on the Stream — the plan, in its own Active Plan column', () => {
        const html = render('stream', { session: session({ plan: { step: 2, of: 4, doing: 'write the tests' } }) });
        expect(html).toMatch(/data-plan-column[\s\S]*?2\/4/);
    });
});
