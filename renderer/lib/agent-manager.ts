import type {
    AgentManagerMcp,
    AgentManagerPersona,
    AgentManagerSidecar,
    AgentManagerState,
    AgentMcpServer,
} from './genie';

/**
 * The agent manager's judgement calls, kept out of the component.
 *
 * Tynn #709 / story #263. The renderer has no DOM harness, so — as everywhere
 * else in `renderer/lib` — the decisions live here and `AgentManager.tsx` only
 * draws what these return. That is what makes "the MCP list shows N servers"
 * and "removing genie is refused" checkable at all, rather than assertions
 * nobody can write.
 */

export type AgentManagerTabId = 'identity' | 'prompt' | 'mcp' | 'sidecar';

export interface AgentManagerTab {
    id: AgentManagerTabId;
    label: string;
    /** A count worth seeing without opening the tab. */
    badge?: string;
}

/**
 * The tabs this agent gets.
 *
 * The surface the owner opened had ONE of these — identity — which is the whole
 * complaint. The sidecar tab is dropped for an agent that IS a sidecar: a
 * sidecar has no sidecar, and a control that acts on nothing is worse than an
 * absent one because it looks like it did something.
 */
export function agentManagerTabs(state: AgentManagerState): AgentManagerTab[] {
    if (!state.ok || !state.agent) return [];
    const tabs: AgentManagerTab[] = [
        { id: 'identity', label: 'Identity' },
        { id: 'prompt', label: 'Prompt & rules' },
        {
            id: 'mcp',
            label: 'MCP',
            badge: state.mcp ? String(state.mcp.servers.length) : undefined,
        },
    ];
    if (!state.agent.isSidecar) tabs.push({ id: 'sidecar', label: 'Sidecar' });
    return tabs;
}

export interface McpDriftNotice {
    tone: 'warn' | 'info' | 'none';
    text: string;
    canRestart: boolean;
}

/**
 * What to say about the gap between the config on disk and the session running.
 *
 * All three TUIs read their MCP servers ONCE, at session start. Nothing anywhere
 * said so, and an afternoon went into an agent that looked healthy and was
 * toolless because a `.mcp.json` edit never reached it.
 *
 * `stale` is a proof (`main/agents/agent-mcp.ts` explains the arithmetic) and is
 * stated as one. `unproven` is NOT turned into "up to date": the data cannot
 * support that, and a false all-clear is the failure mode this surface exists to
 * remove, not one to add.
 */
export function mcpDriftNotice(mcp: AgentManagerMcp): McpDriftNotice {
    if (mcp.drift === 'stale') {
        return {
            tone: 'warn',
            text: `This agent has been running since before ${mcp.configPath} last changed, so it is still using the servers it loaded at start. Restart it to pick these up.`,
            canRestart: true,
        };
    }
    if (mcp.drift === 'unproven') {
        return {
            tone: 'info',
            text: `MCP servers are loaded once, at session start. If you change this list while the agent is running, restart it before expecting the change to reach it.`,
            canRestart: true,
        };
    }
    return { tone: 'none', text: '', canRestart: false };
}

export interface McpRowAction {
    canRemove: boolean;
    /** Why not, for the control's title — never a silent disable. */
    reason: string | null;
}

/**
 * Whether this row's Remove control does anything, and why not when it does not.
 *
 * `genie` (and its AgentInbox channel, which main marks the same way) is the one
 * hard refusal in this surface. It is a refusal rather than a warning because
 * the consequence is invisible: the agent still starts, still draws a square,
 * still looks healthy, and can no longer report that it finished or ask the
 * human anything.
 */
export function mcpRowAction(server: AgentMcpServer, editable: boolean): McpRowAction {
    if (!editable) {
        return {
            canRemove: false,
            reason: `Genie reads this file but does not rewrite it. Edit ${server.source === 'codex' ? '.codex/config.toml' : 'the config file'} directly to change this.`,
        };
    }
    if (server.required) {
        return {
            canRemove: false,
            reason: `The genie server is how this agent tells you it has finished, asks you a question, and reaches every host tool. Without it the agent still starts and still looks healthy — it just cannot reach you.`,
        };
    }
    return { canRemove: true, reason: null };
}

/** Why a managed server is worth a note even though it can be removed. */
export function mcpManagedNote(server: AgentMcpServer): string | null {
    return server.managed && !server.required
        ? 'Genie writes this entry, so removing it comes back on the next workspace sync.'
        : null;
}

/** The editable half of an `AGENT.md`, as the form holds it. */
export interface PersonaDraft {
    purpose: string;
    /** '' means the whole workspace — the file omits the key entirely. */
    scope: string;
    tuis: string[];
    body: string;
}

/** The draft an `AGENT.md` opens with. */
export function personaDraftFrom(persona: AgentManagerPersona): PersonaDraft {
    return {
        purpose: persona.purpose,
        scope: persona.scope ?? '',
        tuis: persona.tuis,
        body: persona.body,
    };
}

/**
 * Whether Save should be enabled.
 *
 * Driver ORDER is not an edit — `tuis` is a set here, and the array is rebuilt
 * on every render, so comparing it positionally would leave Save permanently
 * lit, which is the same as no signal at all. An empty `scope`, on the other
 * hand, IS an edit against a set one: it clears the agent back to the whole
 * workspace.
 */
export function personaIsDirty(loaded: AgentManagerPersona, draft: PersonaDraft): boolean {
    if (draft.purpose !== loaded.purpose) return true;
    if (draft.scope !== (loaded.scope ?? '')) return true;
    if (draft.body !== loaded.body) return true;
    const a = [...draft.tuis].sort();
    const b = [...loaded.tuis].sort();
    return a.length !== b.length || a.some((tui, i) => tui !== b[i]);
}

/** The edit to send, with `undefined` for everything untouched so a save can
 *  never reset a field the human did not open. */
export function personaEditFrom(
    loaded: AgentManagerPersona,
    draft: PersonaDraft,
): { purpose?: string; scope?: string | null; tuis?: string[]; body?: string } {
    const edit: { purpose?: string; scope?: string | null; tuis?: string[]; body?: string } = {};
    if (draft.purpose !== loaded.purpose) edit.purpose = draft.purpose;
    if (draft.scope !== (loaded.scope ?? '')) edit.scope = draft.scope.trim() || null;
    if (draft.body !== loaded.body) edit.body = draft.body;
    const a = [...draft.tuis].sort();
    const b = [...loaded.tuis].sort();
    if (a.length !== b.length || a.some((tui, i) => tui !== b[i])) edit.tuis = draft.tuis;
    return edit;
}

/** One line saying what the sidecar is and whether it is up. */
export function sidecarSummary(sidecar: AgentManagerSidecar): string {
    if (!sidecar.exists || !sidecar.name) {
        return 'This agent has no sidecar. A sidecar keeps a second conversation warm under another driver; switching drivers creates one.';
    }
    return sidecar.running
        ? `${sidecar.name} is running.`
        : `${sidecar.name} is registered and not running.`;
}

/** How this sidecar was matched, spelled out — the FK and the name convention
 *  mean different things, and #708 turns one into the other. */
export function sidecarMatchNote(sidecar: AgentManagerSidecar): string | null {
    if (!sidecar.exists) return null;
    return sidecar.matchedBy === 'parent'
        ? 'Matched by its parent link, so a rename cannot lose it.'
        : 'Matched by the -slave name convention — it carries no parent link yet.';
}
