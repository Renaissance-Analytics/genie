import { terminalPosition, type TerminalPosition } from '../core/terminal-stream.js';
import type { TerminalSourceData, TerminalSourceExit } from './terminal-streams.js';

export interface NativeTerminalValue { id: string; pid: number; shell: string }
export interface NativeTerminalSnapshot extends NativeTerminalValue {
    workspaceId: string | null; scrollback: string; epoch?: string | null; endOffset?: number | null;
}
export interface NativeTerminalAttachment { value: NativeTerminalValue & { scrollback: string }; position: TerminalPosition | null }
interface NativeTerminalBackend {
    openReady(options: { workspaceId: string; cwd: string; command?: string | undefined; cols?: number | undefined; rows?: number | undefined; personal: boolean; env?: Record<string, string> }): Promise<NativeTerminalValue>;
    lastCwd(id: string): string | null;
    write(id: string, data: string): boolean;
    resize(id: string, cols: number, rows: number): boolean;
    close(id: string): boolean;
    writeReady?(id: string, data: string): Promise<boolean>;
    resizeReady?(id: string, cols: number, rows: number): Promise<boolean>;
    closeReady?(id: string): Promise<boolean>;
    list(): readonly (NativeTerminalValue & { workspaceId: string | null })[];
}
export interface NativeTerminalPort {
    invoke(method: string, args: unknown[]): Promise<unknown>;
    snapshot(workspaceId: unknown, id: unknown): Promise<NativeTerminalAttachment | null>;
    listen?(data: (event: TerminalSourceData) => void, exit: (event: TerminalSourceExit) => void): () => void;
}
export interface NativeTerminalDeps {
    terminals(): NativeTerminalBackend | null;
    workspaces(): readonly { id: string; path: string }[];
    trackCwd(): unknown;
    environment(workspaceId: string): Record<string, string>;
    freshSnapshot(id: string): Promise<NativeTerminalSnapshot | null>;
    openError(path: string, error: unknown): void;
    listen?: NativeTerminalPort['listen'];
}

/** The native contract, separately from the unchanged remote terminal routes. */
export function createNativeTerminalPort(deps: NativeTerminalDeps): NativeTerminalPort {
    const snapshot = async (workspaceId: unknown, id: unknown): Promise<NativeTerminalAttachment | null> => {
        if (!deps.terminals() || (typeof workspaceId !== 'string' && workspaceId !== null) || typeof id !== 'string') return null;
        const joined = await deps.freshSnapshot(id);
        if (!joined || (workspaceId !== null && joined.workspaceId !== workspaceId)) return null;
        return { value: { id: joined.id, pid: joined.pid, shell: joined.shell, scrollback: joined.scrollback }, position: terminalPosition(joined) };
    };
    return {
        snapshot,
        ...(deps.listen ? { listen: deps.listen } : {}),
        async invoke(method, args) {
            const t = deps.terminals(), id = args[0];
            switch (method.replace(/^terminals\.local/, '').toLowerCase()) {
                case 'open': {
                    if (!t || typeof id !== 'string') return null;
                    const workspace = deps.workspaces().find(workspace => workspace.id === id);
                    if (!workspace) return null;
                    const options = (args[1] ?? {}) as { cols?: unknown; rows?: unknown; command?: unknown };
                    const cols = typeof options.cols === 'number' && options.cols > 0 ? Math.floor(options.cols) : undefined;
                    const rows = typeof options.rows === 'number' && options.rows > 0 ? Math.floor(options.rows) : undefined;
                    const command = typeof options.command === 'string' && options.command.trim() ? options.command : undefined;
                    try {
                        const cwd = (deps.trackCwd() !== false ? t.lastCwd(id) : null) ?? workspace.path;
                        const env = deps.environment(id);
                        return await t.openReady({ workspaceId: id, cwd, command, cols, rows, personal: true, ...(Object.keys(env).length ? { env } : {}) });
                    } catch (error) { deps.openError(workspace.path, error); throw error; }
                }
                case 'write': return t && typeof id === 'string' && typeof args[1] === 'string' ? await (t.writeReady?.(id, args[1]) ?? t.write(id, args[1])) : false;
                case 'resize': return t && typeof id === 'string' && typeof args[1] === 'number' && typeof args[2] === 'number'
                    ? await (t.resizeReady?.(id, Math.floor(args[1]), Math.floor(args[2])) ?? t.resize(id, Math.floor(args[1]), Math.floor(args[2]))) : false;
                case 'close': return t && typeof id === 'string' ? await (t.closeReady?.(id) ?? t.close(id)) : false;
                case 'list': return t && typeof id === 'string' ? t.list().filter(terminal => terminal.workspaceId === id).map(({ id, pid, shell }) => ({ id, pid, shell })) : [];
                case 'attach': return (await snapshot(id, args[1]))?.value ?? null;
                default: throw new Error('unknown local terminal operation');
            }
        },
    };
}
