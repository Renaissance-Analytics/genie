import type { GenieBridge } from './bridge.js';

/**
 * RE-ATTACH, NOT RE-OPEN (§6.5 multi-attach with scrollback replay). A reloaded window joins the
 * terminals already running in its workspace: list them, ATTACH to each (the scrollback so far
 * comes with the join; the live bytes follow on the data channel). Nothing is spawned here — the
 * old re-attach called `open` once per listed terminal, which spawned one new shell per existing
 * one on every reload and showed the new shell's bytes under the old terminal's id. A terminal
 * that closed between the list and the attach answers null and is dropped.
 */
export interface Attached {
    id: string;
    pid: number;
    shell: string;
    scrollback: string;
}

export async function reattachAll(
    terminals: Pick<GenieBridge['terminals'], 'list' | 'attach'>,
    workspaceId: string,
): Promise<Attached[]> {
    const listed = await terminals.list(workspaceId);
    const joined = await Promise.all(listed.map((t) => terminals.attach(workspaceId, t.id)));
    return joined.filter((t): t is NonNullable<typeof t> => t !== null).map((t) => ({ id: t.id, pid: t.pid, shell: t.shell, scrollback: t.scrollback }));
}

/**
 * WHERE A RE-ATTACH IS (the host split, P2.1; the owner's rule: every action shows its progress, then success or a
 * failure with Retry). After a window restart the terminals still running under genie-host are taken back; the workspace
 * says it is doing so, how many came back, or why none could, with Retry.
 */
export type ReattachState =
    | { readonly phase: 'idle' }
    | { readonly phase: 'reattaching' }
    | { readonly phase: 'attached'; readonly count: number }
    | { readonly phase: 'failed'; readonly reason: string };

/** `reattachAll`, saying where it is through `onState`; a failure is said (and answers no terminals), never thrown. */
export async function reattachWithState(
    terminals: Pick<GenieBridge['terminals'], 'list' | 'attach'>,
    workspaceId: string,
    onState: (state: ReattachState) => void,
): Promise<Attached[]> {
    onState({ phase: 'reattaching' });
    try {
        const joined = await reattachAll(terminals, workspaceId);
        onState({ phase: 'attached', count: joined.length });
        return joined;
    } catch (error) {
        onState({ phase: 'failed', reason: error instanceof Error ? error.message : String(error) });
        return [];
    }
}
