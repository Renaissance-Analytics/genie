import { canResumeTui } from './registry';

/**
 * PURE, and importable from the RENDERER — it reaches nothing but
 * {@link ./registry}, which is itself dependency-free. That matters: the menus
 * that offer a restart live in the renderer, and the only way they can stop
 * disagreeing with the host about what a restart CAN do is to ask the same
 * function the host asks.
 *
 * ## The two operations (genie#443)
 *
 * Genie had ONE where it needs two, and they have different preconditions:
 *
 *  - **Resume** — relaunch and CONTINUE the conversation. Needs a provider with
 *    a resume grammar (`TuiDef.resume`) AND a captured session id.
 *  - **Restart (fresh)** — kill the process and start it again. Needs NEITHER.
 *
 * Sharing one path meant the absence of the first removed the second, so a
 * provider with `resume: null` — the Genie TUI, `custom`, and the twelve added
 * in genie#437 — could not be restarted AT ALL, including when it was dead. The
 * reported terminal had failed at `bash: genie: command not found`: Genie
 * refused to restart it in order to protect a conversation that did not exist.
 *
 * The answer is a SECOND operation, never a weaker first one. Minting a fake
 * session id or loosening `renderAgentResume` would make a wrong `--resume` —
 * which does not error, it silently starts a NEW conversation while the UI says
 * it resumed (genie#440).
 */

/** Which of the two restart operations a caller means. */
export type RestartMode = 'resume' | 'fresh';

/** The agent-relevant slice of a terminal spec's meta (loose so this stays free
 *  of the heavy db types, and usable from the renderer's `TerminalSpec`). */
export interface AgentSpecLike {
    meta?: {
        agent?: string;
        agent_command?: string;
        chat_session_id?: string;
    } | null;
}

/** Extract the uuid from an existing `--session-id <uuid>`/`=uuid`, or null. */
export function extractSessionId(command: string): string | null {
    const m = String(command ?? '').match(
        /--session-id(?:=|\s+)([0-9a-fA-F-]{8,})/,
    );
    return m ? m[1] : null;
}

/**
 * The session id a RELAUNCH should resume — `meta.chat_session_id` when it is
 * there, otherwise the id sitting inside the stored launch command's
 * `--session-id` flag.
 *
 * The second half is genie#364. `--session-id <uuid>` is CREATE-a-session-with-
 * this-id: `renderAgentLaunch` MINTS the uuid so the conversation is identified
 * from the first keystroke, and is idempotent about a flag that is already
 * present. That means the id can end up recorded ONLY in the stored command —
 * the owner's always-on flags may pin one, and a spec written by an older build
 * has one baked in. Reading it here is what lets a relaunch change the flag's
 * VERB (`--resume`) instead of replaying a create that can only ever succeed
 * once ("Error: Session ID <uuid> is already in use").
 *
 * It is also why a FRESH restart has to clear BOTH: clearing the field alone
 * leaves the id in the command, where this function finds it again and the
 * "fresh" relaunch resumes the old chat.
 *
 * `chat_session_id` OUTRANKS the command: it is the live record, updated when a
 * session is detected or re-captured, while a command string can hold a stale id
 * indefinitely.
 */
export function capturedSessionId(spec: AgentSpecLike | null): string | null {
    const meta = spec?.meta;
    if (!meta) return null;
    const stored = meta.chat_session_id?.trim();
    if (stored) return stored;
    return extractSessionId(meta.agent_command ?? '');
}

/** Which restarts a terminal can be offered. */
export interface RestartOptions {
    /** Is this an agent terminal at all? Neither restart applies otherwise. */
    isAgent: boolean;
    /**
     * Offer "Restart (resume)" — the provider has a resume grammar AND a session
     * was captured. Both halves are required: a grammar with no id has nothing
     * to resume, and an id under a provider with no grammar cannot be expressed.
     */
    canResume: boolean;
    /**
     * Offer "Restart (fresh)". TRUE for every agent terminal, with no exception
     * — that is the whole point of genie#443. A wedged or dead agent is exactly
     * the case that needs it most, and it is the case the old gate excluded.
     */
    canRestartFresh: boolean;
    /**
     * A fresh restart would abandon a conversation Genie has a record of, so the
     * user is WARNED first. False when there is none — and then nothing pretends
     * there is, which is what left the owner staring at a toast about protecting
     * a conversation that had never started.
     */
    losesConversation: boolean;
}

export function restartOptionsFor(spec: AgentSpecLike | null | undefined): RestartOptions {
    const agent = spec?.meta?.agent;
    if (!agent) {
        return { isAgent: false, canResume: false, canRestartFresh: false, losesConversation: false };
    }
    // A captured id is a conversation Genie KNOWS about. It is not a claim that
    // an agent with none has never spoken — a `detect`/`hook` provider may hold
    // a chat Genie never bound to — only that there is nothing here that a
    // restart could carry across, and therefore nothing to promise the user.
    const captured = !!capturedSessionId(spec ?? null);
    return {
        isAgent: true,
        canResume: canResumeTui(agent) && captured,
        canRestartFresh: true,
        losesConversation: captured,
    };
}
