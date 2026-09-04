import { parseAgentFile, renderAgentFile, type AgentFileExtra } from './agent-file';

/**
 * Editing an agent's `AGENT.md` — its prompt AND its rules — from the app.
 *
 * Tynn #709. The owner asked for "a full agent manager with agent prompt and
 * rules and MCP management" and the surface they got was a driver picker, a
 * purpose field and two checkboxes. The file has been the source of truth since
 * `registerAgent` shipped and there has never been a way to open it in Genie.
 *
 * PURE — no fs, no database, no electron — for the same reason `agent-file.ts`
 * is: the caller owns reading and writing, and the interesting decisions (what
 * an edit is allowed to change, what it must leave alone) stay testable without
 * a workspace on disk. `persona-store.ts` is the thin layer that reaches the
 * actual file.
 *
 * The one rule everything here serves: **an edit changes what it names and
 * nothing else.** The file is committed and a human owns it. A save that
 * reformatted the prompt, dropped a header key the form does not draw, or reset
 * a field to a default would be worse than having no editor, because the diff
 * would look deliberate and nothing would report an error.
 */

/**
 * What the manager may change.
 *
 * `name` is deliberately ABSENT. Identity is (workspace, name) — the roster, the
 * AgentInbox channel, `.agents/<name>/` and `persona_path` all key on it — so a
 * rename is a migration, not a text field, and offering it here would
 * desynchronise every one of them from a control that looks harmless.
 *
 * Every field is optional and `undefined` means "not edited", which is what
 * makes an empty edit a genuine no-op rather than a reset to defaults.
 */
export interface PersonaEdit {
    purpose?: string;
    /** null clears it back to the whole workspace. */
    scope?: string | null;
    tuis?: string[];
    avatar?: string | null;
    /** The system prompt, verbatim. */
    body?: string;
}

/** One header key Genie has no field for, shown read-only so a human can SEE it
 *  was not lost rather than having to diff the file to find out. */
export interface PersonaExtraView {
    key: string;
    value: string;
}

/** An `AGENT.md`, as the manager draws it. */
export interface PersonaView {
    name: string;
    purpose: string;
    scope: string | null;
    tuis: string[];
    avatar: string | null;
    body: string;
    extra: PersonaExtraView[];
}

/** Read an `AGENT.md`'s text into the shape the manager renders. */
export function personaView(raw: string): PersonaView {
    const parsed = parseAgentFile(raw);
    return {
        name: parsed.config.name,
        purpose: parsed.config.purpose,
        scope: parsed.config.scope,
        tuis: parsed.config.tuis,
        avatar: parsed.config.avatar,
        body: parsed.body,
        extra: parsed.extra.map(([key, value]) => ({ key, value })),
    };
}

/**
 * Apply an edit to an `AGENT.md`'s TEXT and hand back the next text.
 *
 * Goes through `parseAgentFile` / `renderAgentFile` rather than patching lines,
 * so the manager writes files in exactly the shape registration writes them and
 * there is one renderer to be right. `extra` is carried straight through: the
 * keys Genie has no field for are the ones most at risk from an editor, because
 * nothing on screen would show they had gone.
 *
 * With no edit this is the IDENTITY on a file in Genie's key order — opening an
 * agent and pressing Save produces no diff.
 */
export function applyPersonaEdit(raw: string, edit: PersonaEdit): string {
    const parsed = parseAgentFile(raw);
    const extra: AgentFileExtra[] = parsed.extra;
    return renderAgentFile(
        {
            // NOT editable — see PersonaEdit.
            name: parsed.config.name,
            purpose: edit.purpose ?? parsed.config.purpose,
            scope: edit.scope === undefined ? parsed.config.scope : edit.scope,
            tuis: edit.tuis ?? parsed.config.tuis,
            avatar: edit.avatar === undefined ? parsed.config.avatar : edit.avatar,
        },
        edit.body ?? parsed.body,
        extra,
    );
}

/** Whether an edit would change anything, so the manager can disable Save and a
 *  caller can skip a pointless write to a tracked file. */
export function personaEditIsEmpty(raw: string, edit: PersonaEdit): boolean {
    return applyPersonaEdit(raw, edit) === raw;
}

/**
 * The starting text for an agent whose `AGENT.md` was never written.
 *
 * Registration only writes the file when it does not already exist, and it did
 * not exist at all before that shipped — so agents registered earlier have a
 * `persona_path` pointing at nothing. The manager must be able to open one of
 * those and write it, rather than telling the human their agent has no file and
 * leaving them there.
 */
export function blankPersona(name: string, purpose: string, tuis: string[]): string {
    return renderAgentFile(
        { name, purpose, scope: null, tuis, avatar: null },
        `You are ${name}. ${purpose}\n`,
    );
}
