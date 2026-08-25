import type { AgentProvider } from '../agents/identity';

/**
 * PURE. What the `imDone` OS toast SAYS.
 *
 * Genie hosts many workspaces at once with agents running in several of them,
 * and `imDone` exists to pull the user to the ONE terminal that finished. A
 * notice that names neither the workspace nor the agent cannot do that job — it
 * only says that somewhere, something ended, which starts a hunt instead of
 * ending one.
 *
 * Extracted from `background.ts` so the text is testable: the Electron
 * `Notification` itself is a thin leaf (same split `planUpdateNotification`
 * uses).
 */

/** The facts a notice is built from. Every one is optional because every one can
 *  genuinely be missing — an unattached terminal has no workspace, a plain shell
 *  running a finish-hook has no agent, and a deleted spec has neither. */
export interface ImDoneNoticeFacts {
    /** The workspace's display name (`project_name`), or the System Workspace. */
    workspace?: string | null;
    /** The agent running in this terminal, when it is one. */
    agent?: { provider: AgentProvider; name: string } | null;
    /** The terminal spec's own label. */
    terminal?: string | null;
    /**
     * The HOST this finish arrived from, when the user is driving a remote
     * workstation rather than working locally. Absent for a local finish — and
     * the other facts are absent when an OLDER host pushes a `notify:imdone`
     * that carries only the label, which is why every fact here is optional.
     */
    host?: string | null;
}

export interface ImDoneNotice {
    title: string;
    body: string;
}

/** Trim to a non-empty string, or null. */
function clean(v: string | null | undefined): string | null {
    const s = String(v ?? '').trim();
    return s || null;
}

/**
 * The provider as a person reads it. Mirrors the renderer's terminal-type labels
 * (`renderer/lib/terminal-types.ts`) — the toast is plain text, so the provider
 * that would be a LOGO in the UI is spelled out here instead. Same information,
 * same convention: provider + name, never the chat id.
 */
const PROVIDER_LABEL: Record<AgentProvider, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    custom: 'Custom agent',
};

export function planImDoneNotice(facts: ImDoneNoticeFacts): ImDoneNotice {
    const workspace = clean(facts.workspace);
    const terminal = clean(facts.terminal);
    const name = clean(facts.agent?.name);
    const agent = facts.agent && name ? { provider: facts.agent.provider, name } : null;

    // WHO finished. An agent is provider + name; anything else is named by its
    // own label, and only a terminal with neither is anonymous.
    const who = agent
        ? `${PROVIDER_LABEL[agent.provider] ?? 'Agent'} · ${agent.name}`
        : (terminal ?? 'A terminal');

    // WHERE — the missing fact. The workspace leads, because that is what the
    // user is choosing between when several are open and one of them just
    // finished something.
    const title = workspace ? `${workspace} — ${who} finished` : `${who} finished`;

    // The terminal is a TIEBREAKER, not a third name to read: an agent panel's
    // label usually already contains the agent's name (`claude · reviewer`), and
    // repeating it spends one of the toast's two short lines on nothing.
    const showTerminal =
        !!agent && !!terminal && !terminal.toLowerCase().includes(agent.name.toLowerCase());
    const where = showTerminal ? ` in “${terminal}”` : '';
    // One more coordinate on a remote finish, never a replacement for the others:
    // naming only the host is what made the remote toast say "a terminal,
    // somewhere over there".
    const host = clean(facts.host);
    const on = host ? ` on ${host}` : '';

    return { title, body: `Waiting for you${where}${on}. Click to open it.` };
}
