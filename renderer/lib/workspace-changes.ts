import type { AgentSession, ToolCall } from '../../main/agentsession/model';

/**
 * CHANGES THIS SESSION — the part of §5.3's file panel that real data can answer.
 *
 * The owner's requirement for the panel: *"go into a single workspace and see what is being
 * done there"*. The board renders that as a list of changed files, each with who changed it and
 * when, plus a tree whose entries carry the same attribution.
 *
 * Two of those three facts were impossible before genie#843 kept `rawInput` (which file) and
 * `at` (when). The third was never missing: the agent that reported the call IS the author.
 *
 * ## What this refuses to produce
 *
 * The board also shows `+42 −8` per file, a per-line presence (*"atlas is writing lines
 * 23–26"*), and an `on disk · not attributed` row for a write no agent claimed. None of those
 * are derivable from tool calls — they report no line counts or line ranges. Unclaimed disk
 * changes come separately from the existing file watcher when the panel composes its view.
 *
 * They are left out rather than estimated. A `+42` guessed from nothing is worse than no
 * number at all, because a number on screen reads as measured — and this surface's whole value
 * is that a human can trust what it says about who touched their code.
 */

export interface WorkspaceChange {
    /** Relative to the workspace root, because the tree beside it is. */
    path: string;
    /** The agent's name, for display. */
    who: string;
    /** Its id, so a row can open that agent. */
    agentId: string;
    at: number;
}

/** The kinds that CHANGE a file. A read is traffic; the panel is about what moved. Taken from
 *  the agent's own `kind` rather than the tool's name — a provider may call its writer
 *  anything, and matching on prose is how the plan rail broke once already. */
const CHANGING_KINDS = new Set(['edit', 'write', 'create', 'delete', 'move']);

function pathOf(call: ToolCall): string | null {
    const input = call.rawInput;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    for (const key of ['file_path', 'filePath', 'path']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
}

/** Strip the workspace root. The agent reports an absolute path; the panel is rooted at the
 *  workspace, so the prefix is noise — and keeping it would make every row too wide to read
 *  the part that differs. */
function relativeTo(root: string, path: string): string {
    const normal = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const r = normal(root);
    const p = normal(path);
    return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p;
}

export function workspaceChanges(
    sessions: AgentSession[],
    input: { workspaceId: string },
): WorkspaceChange[] {
    /**
     * ONE ROW PER FILE, holding its LATEST change.
     *
     * The board lists files, not events. An agent editing one file four times is one changed
     * file, and four rows would bury the other three files beneath it. When two agents touched
     * the same file, the most recent writer is the answer — "who changed this" has one current
     * answer, and the earlier edit is in the Stream where sequence is the point.
     */
    const latest = new Map<string, WorkspaceChange>();

    for (const session of sessions) {
        if (session.session.workspaceId !== input.workspaceId) continue;
        for (const call of session.tools) {
            if (call.status !== 'success') continue;
            if (call.kind === null || !CHANGING_KINDS.has(call.kind)) continue;
            const absolute = pathOf(call);
            if (!absolute) continue;
            const path = relativeTo(session.session.cwd, absolute);
            const at = call.at ?? 0;
            const existing = latest.get(path);
            if (existing && existing.at >= at) continue;
            latest.set(path, { path, who: session.session.name, agentId: session.agentId, at });
        }
    }

    // Newest first: the panel answers "what just changed", and the answer belongs at the top.
    return [...latest.values()].sort((a, b) => b.at - a.at);
}

/**
 * THE FILES BEING WRITTEN RIGHT NOW.
 *
 * {@link workspaceChanges} reports `status === 'success'` calls, which is every write that has
 * already LANDED. This is the other half: a PENDING call, of a kind the agent classified as
 * changing, whose `rawInput` names a file. `ToolCall.rawInput`'s own doc points here —
 * *"This is where 'it is editing `ipc.ts` right now' comes from"*.
 *
 * Same rules, same helpers, deliberately: the kinds that change a file, the keys a path can
 * arrive under, and the workspace-relative form all come from the code above rather than a
 * second opinion about the same payloads.
 *
 * One entry per FILE — the Map is keyed by path, so two pending calls on one file is one file
 * being written. (An explicit `if (live.has(path)) continue` guard was here and a break probe
 * proved it redundant: the keyed Map already does it. Removed rather than kept as a second
 * opinion about the same thing.)
 */
export function liveWrites(
    sessions: AgentSession[],
    input: { workspaceId: string },
): Array<{ path: string; who: string; agentId: string }> {
    const live = new Map<string, { path: string; who: string; agentId: string }>();
    for (const session of sessions) {
        if (session.session.workspaceId !== input.workspaceId) continue;
        for (const call of session.tools) {
            if (call.status !== 'pending') continue;
            // `kind === null` is a classification Genie was NOT given. A pulse says "this is
            // being edited"; saying it on the strength of a missing field is the claim the
            // null-is-not-zero rule exists to refuse.
            if (call.kind === null || !CHANGING_KINDS.has(call.kind)) continue;
            const absolute = pathOf(call);
            if (!absolute) continue;
            const path = relativeTo(session.session.cwd, absolute);
            live.set(path, { path, who: session.session.name, agentId: session.agentId });
        }
    }
    return [...live.values()];
}
