import { join } from 'node:path';

/**
 * WHAT GENIE-HOST KNOWS OF THIS MACHINE'S WINDOW, AND WHAT IT FINDS FOR ITSELF (Tynn #1044, client/host split step 2g-4d B).
 * Its MCP server reads two facts for its tools: each workspace's name (its project.json, for address slugs) and whether the
 * person is at the computer (ForceTheQuestion's "they are away"). genie-host names its workspaces itself, from its own
 * registry, again on each registry write. Only Electron can tell whether the person is active, so main's own client says
 * that on the local, own-only `window.view`. Genie 1's database is found by genie-host itself, from the userData the window
 * launched it with.
 */
export interface HostWindowView {
    readonly workspaceNames: Readonly<Record<string, string>>;
    readonly userActive: boolean;
}

/** Genie 1's database, from the userData the window launched genie-host with; null when none was given (genie-cloud). */
export function v1DatabaseFrom(env: Readonly<Record<string, string | undefined>>): string | null {
    const userData = env.GENIE_V1_USERDATA;
    return typeof userData === 'string' && userData !== '' ? join(userData, 'genie.db') : null;
}

/** window.view's argument, or why it is refused: only whether the person is active. */
export function readWindowView(args: unknown[]): { userActive: boolean } | { ok: false; reason: string } {
    const v = args[0] as { userActive?: unknown } | null;
    if (!v || typeof v !== 'object' || typeof v.userActive !== 'boolean') return { ok: false, reason: 'window.view says whether the person is active, and nothing else' };
    return { userActive: v.userActive };
}

/** The view genie-host gives its MCP server: its own workspaces' names, and what the window last said of the person. */
export function hostWindowView(_ports: {
    readonly workspaces: () => readonly { readonly id: string; readonly path: string }[];
    readonly nameOf: (path: string) => string;
    readonly setView: (view: HostWindowView) => void | Promise<void>;
    readonly onRegistryWritten: (listener: () => void) => () => void;
}): { userActive(active: boolean): void; refresh(): void } {
    // Away until the window says otherwise: a host with no window has nobody at the computer.
    let active = false;
    const say = (): void => {
        const workspaceNames = Object.fromEntries(ports.workspaces().map((w) => [w.id, ports.nameOf(w.path)]));
        void ports.setView({ workspaceNames, userActive: active });
    };
    ports.onRegistryWritten(say);
    say();
    return {
        userActive: (next) => { active = next; say(); },
        refresh: say,
    };
}
