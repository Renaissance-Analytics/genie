import type { Caller, McpCall } from './mcp-tools.js';
import type { OwnCallAnswer } from './own-protocol-client.js';
import { APPROVAL_SWEEP_MS, APPROVAL_TIMEOUT_MS } from './approval-queue.js';

/**
 * A WINDOW-RUN TOOL'S APPROVAL, ASKED OF GENIE-HOST OVER THE ONE PROTOCOL (Tynn #1006, client/host split step 2g-4b2). The
 * window runs a few of an agent's tools itself (createAgent, workspaceTabs, pages); each asks the person first. The ask is
 * genie-host's one queue (ApprovalQueue), reached on the local, own-only `approvals.gate`, tied to the agent's real call by
 * its forwarded id. What the window cannot hear back in time, or is refused, is a no: the queue's own safe default.
 */
export interface GateRequest {
    readonly caller: Caller;
    readonly action: string;
    readonly detail: string;
    readonly forwardedCallId: string | null;
}
export type GateRefusal = { readonly ok: false; readonly reason: string };

/** How long the window waits for the person's answer: the queue's own expiry, and then some. */
export const APPROVAL_CALL_DEADLINE_MS = APPROVAL_TIMEOUT_MS + APPROVAL_SWEEP_MS + 60_000;

/** The request as it came over the wire, or why it is refused. A flow acts with the person's authority, so a caller is read strictly. */
const WORD_MAX = 200;
const DETAIL_MAX = 4_000;
const word = (v: unknown, max = WORD_MAX): v is string => typeof v === 'string' && v.length <= max;
const refuse = (reason: string): GateRefusal => ({ ok: false, reason });

export function readGateRequest(args: unknown[]): GateRequest | GateRefusal {
    const [c, action, detail, forwardedCallId] = args;
    const r = c as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return refuse('approvals.gate: name who asks');
    if (!word(r.agentId) || r.agentId === '' || !word(r.agentName) || !word(r.workspaceId) || !word(r.workspacePath, 4_096)) return refuse('approvals.gate: who asks is an agent, by its id, name and workspace');
    if (r.kind !== undefined && r.kind !== 'flow' && r.kind !== 'app') return refuse('approvals.gate: who asks is an agent, a flow or an app');
    if (!word(action) || action === '') return refuse('approvals.gate: name the action');
    if (!word(detail, DETAIL_MAX)) return refuse('approvals.gate: say what the action does, briefly');
    if (forwardedCallId !== null && forwardedCallId !== undefined && !word(forwardedCallId)) return refuse("approvals.gate: the agent's call is named by its id");
    const caller = { agentId: r.agentId, agentName: r.agentName, workspaceId: r.workspaceId, workspacePath: r.workspacePath, ...(r.kind === 'flow' || r.kind === 'app' ? { kind: r.kind } : {}) } as Caller;
    return { caller, action, detail, forwardedCallId: typeof forwardedCallId === 'string' ? forwardedCallId : null };
}

/** The window's side: asks genie-host, and reads anything but an allowed answer as denied. */
export function windowApprovals(own: { call(method: 'approvals.gate', args: unknown[], options?: { timeoutMs?: number }): Promise<OwnCallAnswer> }): { gate(caller: Caller, action: string, detail: string, call: McpCall | undefined): Promise<'allowed' | 'denied' | 'expired'> } {
    return {
        gate: async (caller, action, detail, call) => {
            const answer = await own.call('approvals.gate', [caller, action, detail, call?.forwardedCallId ?? null], { timeoutMs: APPROVAL_CALL_DEADLINE_MS });
            if (!answer.ok) return 'denied';
            return answer.value === 'allowed' || answer.value === 'expired' ? answer.value : 'denied';
        },
    };
}
