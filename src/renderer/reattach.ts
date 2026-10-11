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
