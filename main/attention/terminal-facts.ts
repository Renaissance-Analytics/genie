import { getTerminalSpec, getWorkspace } from '../db';
import { workspaceIdOfSpec } from '../terminal/workspace-of-terminal';
import { agentDisplay, type AgentTui } from '../agents/identity';

/**
 * WHO and WHERE a terminal is, for the attention notices that have to name it.
 *
 * Extracted from `background.ts` (where it served `imDone` alone) because the
 * AgentInbox incoming toast needs exactly the same three facts, and a second
 * copy is how two toasts start calling one terminal by two different names.
 *
 * Everything is looked up defensively — a spec can be deleted between the event
 * and the toast, and a plain shell running a finish-hook has no agent at all.
 * Missing facts are simply absent; the notice degrades rather than failing.
 */
export interface TerminalNoticeFacts {
    /** The workspace's display name (`project_name`), or the System Workspace. */
    workspace: string | null;
    /** The agent running in this terminal, when it is one. */
    agent: { tui: AgentTui; name: string } | null;
    /** The terminal spec's own label. */
    terminal: string | null;
    /** The workspace id a reveal must activate (the sentinel for a System
     *  terminal, null for an unattached one). */
    workspaceId: string | null;
}

const UNKNOWN: TerminalNoticeFacts = {
    workspace: null,
    agent: null,
    terminal: null,
    workspaceId: null,
};

export function terminalNoticeFacts(terminalId: string): TerminalNoticeFacts {
    try {
        const spec = getTerminalSpec(terminalId);
        if (!spec) return UNKNOWN;
        const wsId = workspaceIdOfSpec(spec);
        // One lookup. The System Workspace used to need a hard-coded label here
        // because there was no row to read a name off; there is one now.
        const workspace = wsId ? getWorkspace(wsId)?.project_name ?? null : null;
        // The identity convention (#258): tui + NAME, never the chat id.
        // `whisper_purpose` IS the agent's name — see agents/identity.ts, which
        // deliberately makes them the same field so the two can't drift.
        const tui = spec.meta?.agent;
        const agent = tui
            ? agentDisplay({ tui, name: spec.meta?.whisper_purpose ?? '' })
            : null;
        return { workspace, agent, terminal: spec.label, workspaceId: wsId };
    } catch {
        return UNKNOWN;
    }
}
