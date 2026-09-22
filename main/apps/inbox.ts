import { decideAppCall, type AppGrant } from './bridge-decision';
import { resolveAgentAddress } from '../agentinbox/address';
import type { AgentInboxBroker } from '../agentinbox/broker';
import type { AgentInboxRequest, AgentInboxResult } from '../mcp/protocol';
export function appInboxCall(grant: AppGrant | null, request: AgentInboxRequest, broker: AgentInboxBroker): AgentInboxResult {
    const decision = decideAppCall({ tool: 'agentinbox', workspaceId: request.workspaceId }, grant);
    if (!decision.allowed || !grant) return { ok: false, error: decision.reason };
    const peers = broker.discoverableForApp(grant.appId, grant.workspaceId)
        .filter(peer => peer.workspaceId === decision.workspaceId);
    if (request.action === 'list') return { ok: true, agents: peers };
    if (request.action !== 'send') return { ok: false, error: 'Apps may only list recipients and send messages; agent inbox operations require an agent identity.' };
    if (request.attachments?.length) return { ok: false, error: 'App inbox messages do not support file attachments.' };
    if (!request.to || !request.text?.trim()) return { ok: false, error: 'Sending needs a recipient and non-empty text.' };
    const addressed = resolveAgentAddress(request.to, peers, decision.workspaceId);
    if (!addressed.ok) return { ok: false, error: addressed.error };
    // UUID addresses must also belong to the authorized target workspace.
    if (!peers.some(peer => peer.agentId === addressed.agentId)) return { ok: false, error: 'That agent is outside the app authorized recipients.' };
    const prefix = `[${grant.appName} (a Genie App)] `;
    return broker.send({
        source: { kind: 'app', id: grant.appId, label: grant.appName, workspaceId: grant.workspaceId },
        toAgentId: addressed.agentId,
        text: request.text.startsWith(prefix) ? request.text : prefix + request.text,
        interrupt: request.interrupt,
    });
}
