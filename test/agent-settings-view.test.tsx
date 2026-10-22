import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { SettingsSection } from '../src/core/agent-settings-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * AGENT SETTINGS — ONE AGENT'S OWN VIEW (the owner, 2026-10-19: "Genie should have 3 primary settings views —
 * Workstation, Workspace, and Agent"; approved FTQ q_09d1f4a0: "Agent: provider, model, mode, autonomy, IssueWatch,
 * permissions"). The tab had all but the PROVIDER; it is there now, and its switches are Fancy's.
 */

const session = { running: true, turnState: 'idle', startedAt: 0, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
const AGENT = { id: 'kai', name: 'kai', provider: 'codex', fidelity: 'declared' as const, cwd: '/w' };
const switched: string[] = [];
const ops = { mode: 'automated', accessScope: 'self', autoApprove: true, onMode: () => {}, onSetAutoApprove: () => {}, onSwitchDriver: (to: string) => { switched.push(to); }, onRestart: () => {}, onDelete: () => {} } as never;
const render = (o: unknown, section: SettingsSection = 'general') => renderToStaticMarkup(<AgentView agent={AGENT} session={session} rows={[]} tab="settings" settingsSection={section} lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={o as never} />);
const settings = (html: string) => html.slice(html.indexOf('data-agent-settings'));

describe('the agent’s Settings tab', () => {
    it('names its PROVIDER, a Fancy Select with the one it runs on chosen', () => {
        const html = settings(render(ops));
        const provider = html.match(/data-agent-provider[\s\S]*?<\/select>/)?.[0] ?? '';
        expect(provider).toContain('data-react-fancy-select');
        expect(provider).toMatch(/<option value="codex" selected=""/);
        expect([...provider.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1])).toEqual(['claude', 'codex']);
    });

    it('autonomy is a Fancy Switch, and says that creating an agent always asks you', () => {
        const html = settings(render(ops, 'permissions')); // Autonomous is on the Permissions sub-tab
        expect(html).toMatch(/data-auto-approve="on"[\s\S]{0,400}?data-react-fancy-switch|data-react-fancy-switch[\s\S]{0,400}?data-auto-approve="on"/);
        expect(html).toMatch(/Creating an agent always asks you/);
        expect(html).not.toMatch(/<input type="checkbox"/);
    });

    it('CONTROL: a window that cannot switch the provider (no ops) draws no provider control', () => {
        expect(settings(render(undefined))).not.toContain('data-agent-provider');
    });
});
