import { callerWorkspaceDescriptor } from '../mcp/caller-workspace';
import {
    normalizePurpose,
    type AgentInboxAgentType,
    type AgentInboxJoinInput,
    type AgentInboxScope,
} from './types';

/** The slice of a terminal spec an AgentInbox identity is built from. */
interface JoinableSpec {
    id: string;
    workspace_id: string | null;
    label: string;
    meta?: {
        system?: boolean;
        agent?: unknown;
        agent_id?: string;
        whisper_purpose?: string;
        whisper_scope?: unknown;
        whisper_workspaces?: unknown;
        whisper_wake_on_dm?: boolean;
        chat_session_id?: string | null;
    } | null;
}

/** The workspace row this needs, as a port — no db import, so it stays pure. */
type WorkspaceLookup = (
    id: string,
) => { id: string; project_name: string; path?: string } | undefined;

/**
 * Build an AgentInbox join input from a persisted terminal spec. Null when the
 * spec is not an AgentInbox agent (no `agent_id`) or its workspace is gone.
 *
 * The workspace is resolved through `callerWorkspaceDescriptor`, NOT by reading
 * `spec.workspace_id` raw — the distinction genie#321 drew and genie#352 found
 * the other half of. A system spec IS in a workspace: the synthetic one. The
 * workstation operator is the one agent that is always a system spec (it is
 * deliberately not a workspace agent, so deleting a project cannot delete or
 * re-parent it), so reading the column directly meant the OSA was never
 * rehydrated into the broker at boot — absent from `directory()`, absent from
 * the human's inbox panel, and unreachable by the upgrade broadcast built from
 * that directory.
 *
 * A terminal genuinely in no workspace — no row, no system flag — is still
 * refused, exactly as before.
 */
export function agentInboxJoinInputFor(
    spec: JoinableSpec | null,
    lookupWorkspace: WorkspaceLookup,
): AgentInboxJoinInput | null {
    if (!spec) return null;
    const agentId = spec.meta?.agent_id;
    if (!agentId) return null;
    const ws = callerWorkspaceDescriptor(spec, lookupWorkspace);
    if (!ws) return null;
    return {
        agentId,
        terminalId: spec.id,
        workspaceId: ws.id,
        workspaceName: ws.name,
        slug: ws.slug,
        agentType: (spec.meta?.agent as AgentInboxAgentType) ?? 'custom',
        label: spec.label,
        purpose: normalizePurpose(spec.meta?.whisper_purpose),
        scope: (spec.meta?.whisper_scope as AgentInboxScope) ?? 'self',
        scopeWorkspaces: Array.isArray(spec.meta?.whisper_workspaces)
            ? (spec.meta.whisper_workspaces as string[])
            : [],
        chatSessionId: spec.meta?.chat_session_id ?? null,
        // Default ON (owner, beta.248): the meta key is written ONLY when someone
        // sets the toggle, so `undefined` means "never chose" → announce, and only
        // an explicit `false` silences the agent.
        wakeOnDm: spec.meta?.whisper_wake_on_dm !== false,
    };
}
