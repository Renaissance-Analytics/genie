import { expect, it } from 'vitest';
import { AgentInboxBroker } from '../../agentinbox/broker';
import { appInboxCall } from '../inbox';
import type { AppGrant } from '../bridge-decision';
import type { AgentInboxJoinInput } from '../../agentinbox/types';
const grant: AppGrant = { appId: 'hb', appName: 'Homeward Bound', workspaceId: 'home', scope: 'self', capabilities: ['notify'], revoked: false };
function fresh(scope: AgentInboxJoinInput['scope'] = 'self') {
    const broker = new AgentInboxBroker();
    broker.join({ agentId: 'target', terminalId: 'target-terminal', workspaceId: 'home', workspaceName: 'Home', slug: 'home', agentType: 'codex', label: 'Helper', purpose: 'helper', scope, scopeWorkspaces: [], chatSessionId: null });
    return broker;
}
it('delivers real inbox mail as the app, with no fake agent or terminal identity', async () => {
    const broker = fresh();
    const result = appInboxCall(grant, { action: 'send', to: 'target', text: 'Owner answered.' }, broker);
    expect(result.ok).toBe(true);
    const { messages } = await broker.receive('target');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: 'genie:app:hb', fromLabel: 'App: Homeward Bound', text: '[Homeward Bound (a Genie App)] Owner answered.' });
    expect(broker.directory()).toHaveLength(1);
});
it('lists reachable recipients and retains notify revocation at the final inbox handler', () => {
    const broker = fresh();
    expect(appInboxCall(grant, { action: 'list' }, broker).agents?.map(a => a.agentId)).toEqual(['target']);
    const refused = appInboxCall({ ...grant, capabilities: [] }, { action: 'send', to: 'target', text: 'x' }, broker);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not granted/);
});
it('does not let an app use machine delivery to bypass a private target mailbox', () => {
    const broker = fresh('hidden');
    expect(broker.send({ source: { kind: 'app', id: 'hb', label: 'Homeward Bound', workspaceId: 'home' }, toAgentId: 'target', text: 'x' }).ok).toBe(false);
});
it('refuses agent-only operations instead of inventing an inbox identity for the app', () => {
    expect(appInboxCall(grant, { action: 'receive' }, fresh()).error).toMatch(/only.*list.*send/i);
});
