/**
 * WHERE A TERMINAL AND A FOLDER BELONG, FOR A SHARE (Tynn #691). main/remote-host.ts holds a guest of one workspace to that
 * workspace's terminals and folders, by asking which workspace a terminal is in and where each workspace's folder is. With
 * no answer it refuses (deny by default), so genie-host answers both from what it owns: its terminal host and its registry.
 */

/**
 * A terminal's workspace: a live one from the terminal host's list; one that has ended from the host's record of it, so its
 * exit still reaches the guest whose terminal it was; one the host cannot place: `null`, which refuses it.
 */
export function terminalWorkspaceOf(terminals: {
    list(): readonly { readonly id: string; readonly workspaceId: string }[];
    finished?(id: string): { readonly workspaceId: string } | null;
}): (terminalId: string) => string | null {
    return (terminalId) => terminals.list().find((t) => t.id === terminalId)?.workspaceId ?? terminals.finished?.(terminalId)?.workspaceId ?? null;
}

/** Each registered workspace's folder: how far a guest may browse, and where its picker opens. */
export function workspaceFolders(list: () => readonly { readonly id: string; readonly path: string }[]): () => Readonly<Record<string, string>> {
    return () => Object.fromEntries(list().map((w) => [w.id, w.path]));
}
