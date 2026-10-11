import { DOCK_WIDTH, type DockPanel } from './dock.js';

/**
 * THE FILE PANEL POPPED OUT, AND THE AGENT PAUSED ON A CONFLICTED FILE (§4.3) — the pure half.
 *
 * "It can be popped into its own window — and there is still only one." Popped out, the panel
 * releases the dock reserve: the slot stays pinned to that workspace (the lamp stays on), the
 * content row gets its width back, and the dock column is a bar that brings the panel back.
 *
 * "You can type in the same file an agent is editing… the agent pauses on that file." Genie cannot
 * stop a provider's tool call mid-flight (§2.1: if the protocol does not offer it, Genie does not
 * claim it), so the pause is an ASK — one message to the agent per episode, lifted when the buffer is
 * clean again — and every surface says "asked to pause", never "stopped".
 */

export interface FilesDockState {
    readonly kind: 'docked' | 'popped' | 'none';
    readonly workspaceId: string | null;
    /** The content row's margin: the dock width while the panel is in the slot, 0 otherwise. */
    readonly reserve: number;
}

export function filesDock(input: { pinned: DockPanel | null; filesWorkspaceId: string | null; popped: readonly string[] }): FilesDockState {
    if (input.pinned !== 'files' || !input.filesWorkspaceId) return { kind: 'none', workspaceId: null, reserve: 0 };
    if (input.popped.includes(input.filesWorkspaceId)) return { kind: 'popped', workspaceId: input.filesWorkspaceId, reserve: 0 };
    return { kind: 'docked', workspaceId: input.filesWorkspaceId, reserve: DOCK_WIDTH };
}

export interface Pause {
    readonly agent: string;
    readonly path: string;
}

/** Agents WRITING a file you have dirty, not yet asked. Reading is not a conflict. */
export function pauseRequests(
    activity: readonly { agent: string; verb: string; path: string }[],
    dirty: readonly string[],
    paused: readonly Pause[],
): Pause[] {
    const out: Pause[] = [];
    for (const a of activity) {
        if (a.verb !== 'writing' || !dirty.includes(a.path)) continue;
        if (paused.some((p) => p.agent === a.agent && p.path === a.path) || out.some((p) => p.agent === a.agent && p.path === a.path)) continue;
        out.push({ agent: a.agent, path: a.path });
    }
    return out;
}

/** The pauses whose file is clean again (saved or reverted) — lifted now, whatever the agent is doing. */
export function resumed(paused: readonly Pause[], dirty: readonly string[]): Pause[] {
    return paused.filter((p) => !dirty.includes(p.path));
}

export function pauseMessage(path: string): string {
    return `Genie: a person has unsaved edits open on ${path} in the file panel. Do not write to it until they say so; your other work can continue.`;
}

export function resumeMessage(path: string): string {
    return `Genie: ${path} is saved on the person's side; you may write to it again.`;
}
