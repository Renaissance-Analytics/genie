import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SettingsSection } from '../src/core/agent-settings-view.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * MODE AND ACCESS SCOPE ON THE AGENT VIEW (§6.2, §6.4). Mode is a two-way control — automated / manual —
 * and the view SAYS it is wording for the agent, not a permission boundary. Access scope is the agent's
 * own half of who may message it (none / self / all). Both live in the rail; neither is drawn without ops.
 */

const agent = { id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
const ops = (over: Partial<AgentOpsProps> = {}): AgentOpsProps => ({
    deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'manual', accessScope: 'self',
    onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
    onSetMode: () => {}, onSetAccessScope: () => {},
    ...over,
});
// Mode is on the Settings tab’s General sub-tab, who may message it on Permissions (agent-management parity item 3).
const render = (o?: AgentOpsProps, section: SettingsSection = 'general') =>
    renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="settings" settingsSection={section} lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} ops={o} />);

describe('mode and access scope', () => {
    it('shows the current mode, offers the other, and says mode is wording only', () => {
        const html = render(ops());
        expect(html).toContain('data-mode="manual"');
        expect(html).toContain('data-action="mode-automated"');
        expect(html).toMatch(/wording for the agent, not a permission boundary/);
        const auto = render(ops({ mode: 'automated' }));
        expect(auto).toContain('data-mode="automated"');
        expect(auto).toContain('data-action="mode-manual"');
    });

    it('access scope is a select with the three values and the current one selected', () => {
        const html = render(ops({ accessScope: 'all' }), 'permissions');
        expect(html).toContain('data-access-scope="all"');
        expect(html).toMatch(/<option value="none"/);
        expect(html).toMatch(/<option value="self"/);
        expect(html).toMatch(/<option value="all" selected=""/);
    });

    it('nothing of it without ops', () => {
        const none = render();
        expect(render(undefined, 'permissions')).not.toContain('data-access-scope=');
        expect(none).not.toContain('data-mode=');
        expect(none).not.toContain('data-access-scope=');
    });
});
