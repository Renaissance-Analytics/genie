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
export function v1DatabaseFrom(_env: Readonly<Record<string, string | undefined>>): string | null { throw new Error('2g-4d B: not built yet'); }

/** window.view's argument, or why it is refused: only whether the person is active. */
export function readWindowView(_args: unknown[]): { userActive: boolean } | { ok: false; reason: string } { throw new Error('2g-4d B: not built yet'); }

/** The view genie-host gives its MCP server: its own workspaces' names, and what the window last said of the person. */
export function hostWindowView(_ports: {
    readonly workspaces: () => readonly { readonly id: string; readonly path: string }[];
    readonly nameOf: (path: string) => string;
    readonly setView: (view: HostWindowView) => void | Promise<void>;
    readonly onRegistryWritten: (listener: () => void) => () => void;
}): { userActive(active: boolean): void; refresh(): void } {
    throw new Error('2g-4d B: not built yet');
}
