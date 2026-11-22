import type { Caller, McpCall } from './mcp-tools.js';
import type { OwnCallAnswer } from './own-protocol-client.js';

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
export const APPROVAL_CALL_DEADLINE_MS = 0;

/** The request as it came over the wire, or why it is refused. A flow acts with the person's authority, so a caller is read strictly. */
export function readGateRequest(_args: unknown[]): GateRequest | GateRefusal { throw new Error('2g-4b2: not built yet'); }

/** The window's side: asks genie-host, and reads anything but an allowed answer as denied. */
export function windowApprovals(_own: { call(method: 'approvals.gate', args: unknown[], options?: { timeoutMs?: number }): Promise<OwnCallAnswer> }): { gate(caller: Caller, action: string, detail: string, call: McpCall | undefined): Promise<'allowed' | 'denied'> } {
    throw new Error('2g-4b2: not built yet');
}
