import fs from 'node:fs';
import path from 'node:path';

/**
 * The note an agent leaves for whoever picks its name up next.
 *
 * Agents are restarted constantly — an upgrade, a crash, a human killing a
 * terminal — and until now the next one started from nothing. Genie could not
 * fill that gap on its own: `imDone` knows a terminal ended, not what the agent
 * was in the middle of. So the outgoing agent writes it, on the one call it
 * already makes when it stops.
 *
 * It lives in `.ai/handoff/`, a directory the envelope already reserves and
 * gitignores — this is workstation state, not project history, and it must not
 * turn into a committed file someone has to review.
 *
 * One file per AGENT NAME, not per terminal: a terminal id changes every
 * restart, which is exactly the identity that fails to carry across the gap the
 * handoff exists to bridge.
 */

/** Where an agent's handoff note lives. Name is normalised the same way the
 *  agent's own `.agents/<name>/` folder is, so the two stay in step. */
export function handoffPath(workspaceRoot: string, agentName: string): string {
    const slug = agentName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return path.join(workspaceRoot, '.ai', 'handoff', `${slug || 'agent'}.md`);
}

/** The note itself. Deliberately plain markdown a human can read and edit. */
export function renderHandoff(input: {
    agentName: string;
    note: string;
    at?: Date;
}): string {
    const at = (input.at ?? new Date()).toISOString();
    return [
        `# Handoff — ${input.agentName}`,
        '',
        `_Left at ${at} by the previous run of this agent._`,
        '',
        input.note.trim(),
        '',
    ].join('\n');
}

/**
 * Write the note, best-effort.
 *
 * Returns whether it landed. A handoff that cannot be written must never take
 * down the `imDone` that carried it — the glow telling a human their agent
 * finished matters more than the note, and losing both because a disk was full
 * would be the worse failure.
 */
export function writeHandoff(input: {
    workspaceRoot: string;
    agentName: string;
    note: string;
    at?: Date;
}): boolean {
    const note = input.note.trim();
    // Nothing to say is not a handoff. Writing an empty file would leave the
    // NEXT agent reading a note that tells it nothing, which is worse than
    // finding none — it looks like the previous run had nothing to report.
    if (!note) return false;
    try {
        const file = handoffPath(input.workspaceRoot, input.agentName);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, renderHandoff({ ...input, note }), 'utf8');
        return true;
    } catch {
        return false;
    }
}

/** The note left for this agent, or null when there is none. */
export function readHandoff(workspaceRoot: string, agentName: string): string | null {
    try {
        const file = handoffPath(workspaceRoot, agentName);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    } catch {
        return null;
    }
}
